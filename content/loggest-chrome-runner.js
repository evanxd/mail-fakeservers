/**
 * Minimal test running framework.
 *
 * We:
 * - turn off things that might needlessly mess with the test
 * - use a test runner that can be run from content / anywhere
 * - augment the error reporting capabilities of the test runner by listening to
 *   the console service and friends
 * - use a custom protocol so we get a distinct origin per test file
 * - ensure permissions are set for our custom origin
 * - make sure devicestorage uses our profile directory rather than randomly
 *   touching the FS.
 * - write the test log
 *
 * This file is currently a little soupy; various logic is all mixed in here.
 **/
try {

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cr = Components.results;
const Cu = Components.utils;
const CC = Components.Constructor;

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/commonjs/promise/core.js");
Cu.import("resource://gre/modules/osfile.jsm");

const IOService = CC('@mozilla.org/network/io-service;1', 'nsIIOService')();
const URI = IOService.newURI.bind(IOService);

////////////////////////////////////////////////////////////////////////////////
// have all console.log usages in this file be pretty to dump()

Services.prefs.setBoolPref('browser.dom.window.dump.enabled', true);

function consoleHelper() {
  var msg = arguments[0] + ':';
  for (var i = 1; i < arguments.length; i++) {
    msg += ' ' + arguments[i];
  }
  msg += '\x1b[0m\n';
  dump(msg);
}
window.console = {
  log: consoleHelper.bind(null, '\x1b[32mLOG'),
  error: consoleHelper.bind(null, '\x1b[31mERR'),
  info: consoleHelper.bind(null, '\x1b[36mINF'),
  warn: consoleHelper.bind(null, '\x1b[33mWAR')
};

console.log('Initial loggest-chrome-runner.js bootstrap begun');

////////////////////////////////////////////////////////////////////////////////
// Error handling support; call directly into the page's ErrorTrapper

const nsIScriptError = Ci.nsIScriptError;

var ErrorTrapperHelper = {
  observe: function (aMessage, aTopic, aData) {
    if (aTopic == "profile-after-change")
      return;
    else if (aTopic == "quit-application") {
      this.unhookConsoleService();
      return;
    }

    try {
      if (aMessage instanceof nsIScriptError) {
        // The CSS Parser just makes my life sad.
        if (aMessage.category == "CSS Parser")
          return;

        if (aMessage.flags & nsIScriptError.warningFlag)
          return;
        if (aMessage.flags & nsIScriptError.strictFlag)
          return;

        console.error(aMessage.errorMessage + ' [' + aMessage.category + ']',
                      aMessage.sourceName, aMessage.lineNumber);

        if (gRunnerWindow && gRunnerWindow.ErrorTrapper) {
          gRunnerWindow.ErrorTrapper.fire(
            'uncaughtException',
            {
              name: 'ConsoleError',
              message: aMessage.errorMessage + ' [' + aMessage.category +
                ']',
              stack: [
                {
                  filename: aMessage.sourceName,
                  lineNo: aMessage.lineNumber,
                  funcName: '',
                }
              ]
            });
        }
      }
    } catch (ex) {
      dump("SELF-SPLOSION: " + ex + "\n");
    }
  },

  hookConsoleService: function() {
    this.consoleService = Cc["@mozilla.org/consoleservice;1"]
                            .getService(Ci.nsIConsoleService);
    this.consoleService.registerListener(this);

    // We need to unregister our listener at shutdown if we don't want
    //  explosions
    this.observerService = Cc["@mozilla.org/observer-service;1"]
                             .getService(Ci.nsIObserverService);
    this.observerService.addObserver(this, "quit-application", false);
  },
  unhookConsoleService: function () {
    this.consoleService.unregisterListener(this);
    this.observerService.removeObserver(this, "quit-application");
    this.consoleService = null;
    this.observerService = null;
  },
};
ErrorTrapperHelper.hookConsoleService();

////////////////////////////////////////////////////////////////////////////////
// xpcshell head.js choice logic

// Disable automatic network detection, so tests work correctly when
// not connected to a network.
let (ios = Components.classes["@mozilla.org/network/io-service;1"]
           .getService(Components.interfaces.nsIIOService2)) {
  ios.manageOfflineStatus = false;
  ios.offline = false;
}

// Disable IPv6 lookups for 'localhost' on windows.
try {
  if ("@mozilla.org/windows-registry-key;1" in Components.classes) {
    let processType = Components.classes["@mozilla.org/xre/runtime;1"].
      getService(Components.interfaces.nsIXULRuntime).processType;
    if (processType == Components.interfaces.nsIXULRuntime.PROCESS_TYPE_DEFAULT) {
      let (prefs = Components.classes["@mozilla.org/preferences-service;1"]
                   .getService(Components.interfaces.nsIPrefBranch)) {
        prefs.setCharPref("network.dns.ipv4OnlyDomains", "localhost");
      }
    }
  }
}
catch (e) { }

/**
 * Overrides idleService with a mock.  Idle is commonly used for maintenance
 * tasks, thus if a test uses a service that requires the idle service, it will
 * start handling them.
 * This behaviour would cause random failures and slowdown tests execution,
 * for example by running database vacuum or cleanups for each test.
 *
 * @note Idle service is overridden by default.  If a test requires it, it will
 *       have to call do_get_idle() function at least once before use.
 */
var _fakeIdleService = {
  get registrar() {
    delete this.registrar;
    return this.registrar =
      Components.manager.QueryInterface(Components.interfaces.nsIComponentRegistrar);
  },
  contractID: "@mozilla.org/widget/idleservice;1",
  get CID() this.registrar.contractIDToCID(this.contractID),

  activate: function FIS_activate()
  {
    if (!this.originalFactory) {
      // Save original factory.
      this.originalFactory =
        Components.manager.getClassObject(Components.classes[this.contractID],
                                          Components.interfaces.nsIFactory);
      // Unregister original factory.
      this.registrar.unregisterFactory(this.CID, this.originalFactory);
      // Replace with the mock.
      this.registrar.registerFactory(this.CID, "Fake Idle Service",
                                     this.contractID, this.factory
      );
    }
  },

  deactivate: function FIS_deactivate()
  {
    if (this.originalFactory) {
      // Unregister the mock.
      this.registrar.unregisterFactory(this.CID, this.factory);
      // Restore original factory.
      this.registrar.registerFactory(this.CID, "Idle Service",
                                     this.contractID, this.originalFactory);
      delete this.originalFactory;
    }
  },

  factory: {
    // nsIFactory
    createInstance: function (aOuter, aIID)
    {
      if (aOuter) {
        throw Components.results.NS_ERROR_NO_AGGREGATION;
      }
      return _fakeIdleService.QueryInterface(aIID);
    },
    lockFactory: function (aLock) {
      throw Components.results.NS_ERROR_NOT_IMPLEMENTED;
    },
    QueryInterface: function(aIID) {
      if (aIID.equals(Components.interfaces.nsIFactory) ||
          aIID.equals(Components.interfaces.nsISupports)) {
        return this;
      }
      throw Components.results.NS_ERROR_NO_INTERFACE;
    }
  },

  resetIdleTimeOut: function(idleDeltaInMS) {
  },

  // nsIIdleService
  get idleTime() 0,
  addIdleObserver: function () {},
  removeIdleObserver: function () {},


  QueryInterface: function(aIID) {
    // Useful for testing purposes, see test_get_idle.js.
    if (aIID.equals(Components.interfaces.nsIFactory)) {
      return this.factory;
    }
    if (aIID.equals(Components.interfaces.nsIIdleService) ||
        aIID.equals(Components.interfaces.nsIIdleServiceInternal) ||
        aIID.equals(Components.interfaces.nsISupports)) {
      return this;
    }
    throw Components.results.NS_ERROR_NO_INTERFACE;
  }
};

_fakeIdleService.activate();

function do_get_file(path, allowNonexistent) {
  try {
    let lf = Components.classes["@mozilla.org/file/directory_service;1"]
      .getService(Components.interfaces.nsIProperties)
      .get("CurWorkD", Components.interfaces.nsILocalFile);

    let bits = path.split("/");
    for (let i = 0; i < bits.length; i++) {
      if (bits[i]) {
        if (bits[i] == "..")
          lf = lf.parent;
        else
          lf.append(bits[i]);
      }
    }

    if (!allowNonexistent && !lf.exists()) {
      // Not using do_throw(): caller will continue.
      _passed = false;
      var stack = Components.stack.caller;
      _dump("TEST-UNEXPECTED-FAIL | " + stack.filename + " | [" +
            stack.name + " : " + stack.lineNumber + "] " + lf.path +
            " does not exist\n");
    }

    return lf;
  }
  catch (ex) {
    console.error('do_get_file problem:', ex, '\n', ex.stack);
  }

  return null;
}

// Map resource://test/ to current working directory and
// resource://testing-common/ to the shared test modules directory.
function register_resource_alias(alias, file) {
  let (ios = Components.classes["@mozilla.org/network/io-service;1"]
             .getService(Components.interfaces.nsIIOService)) {
    let protocolHandler =
      ios.getProtocolHandler("resource")
         .QueryInterface(Components.interfaces.nsIResProtocolHandler);
    let dirURI = ios.newFileURI(file);
    console.log('adding resources alias:', alias, 'to', dirURI.path);
    protocolHandler.setSubstitution(alias, dirURI);
  };
}

////////////////////////////////////////////////////////////////////////////////
// mailnews useful logic

// from alertTestUtils.js:
var alertUtilsPromptService = {
  alert: function(aParent, aDialogTitle, aText) {
    dump("ALERT: " + aText + "\n");
    return;
  },

  alertCheck: function(aParent, aDialogTitle, aText, aCheckMsg, aCheckState) {
    dump("ALERTCHECK: " + aText + "\n");
    return;
  },

  confirm: function(aParent, aDialogTitle, aText) {
    dump("CONFIRM: " + aText + "\n");
    return false;
  },

  confirmCheck: function(aParent, aDialogTitle, aText, aCheckMsg, aCheckState) {
    dump("CONFIRMCHECK: " + aText + "\n");
    return false;
  },

  confirmEx: function(aParent, aDialogTitle, aText, aButtonFlags, aButton0Title,
                      aButton1Title, aButton2Title, aCheckMsg, aCheckState) {
    dump("CONFIRMEX: " + aText + "\n");
    return 0;
  },

  prompt: function(aParent, aDialogTitle, aText, aValue, aCheckMsg,
                   aCheckState) {
    dump("PROMPT: " + aText + "\n");
    return false;
  },

  promptUsernameAndPassword: function(aParent, aDialogTitle, aText, aUsername,
                                      aPassword, aCheckMsg, aCheckState) {
    dump("PROMPTUSERPW: " + aText + "\n");
    return false;
  },

  promptPassword: function(aParent, aDialogTitle, aText, aPassword, aCheckMsg,
                           aCheckState) {
    dump("PROMPTPW: " + aText + "\n");
    return false;
  },

  select: function(aParent, aDialogTitle, aText, aCount, aSelectList,
                   aOutSelection) {
    dump("SELECT: " + aText + "\n");
    return false;
  },

  createInstance: function createInstance(outer, iid) {
    if (outer != null)
      throw Components.results.NS_ERROR_NO_AGGREGATION;
    return this.QueryInterface(iid);
  },

  QueryInterface: XPCOMUtils.generateQI([Ci.nsIPromptService,
                                         Ci.nsIPromptService2])
};

function registerAlertTestUtils()
{
  Components.manager.QueryInterface(Components.interfaces.nsIComponentRegistrar)
            .registerFactory(Components.ID("{4637b567-6e2d-4a24-9775-e8fc0fb159ba}"),
                             "Fake Prompt Service",
                             "@mozilla.org/embedcomp/prompt-service;1",
                             alertUtilsPromptService);
}

//registerAlertTestUtils();

////////////////////////////////////////////////////////////////////////////////
// custom protocol stuff from :gozala's protocol implementation




////////////////////////////////////////////////////////////////////////////////
// stuff from xpcshell-type context; probably remove

const STATE_STOP = Ci.nsIWebProgressListener.STATE_STOP,
      STATE_IS_WINDOW = Ci.nsIWebProgressListener.STATE_IS_WINDOW;

function ProgressListener(callOnLoad) {
  this._callOnLoad = callOnLoad;
}
ProgressListener.prototype = {
  onLocationChange: function() {
    console.log('location change!');
  },
  onProgressChange: function() {
    console.log('progress change!');
  },
  onSecurityChange: function() {
    console.log('security change!');
  },
  onStateChange: function(aWebProgress, aRequest, aStateFlags, aStatus) {
    //console.log('state change', aStateFlags);
    if (aStateFlags & STATE_STOP && aStateFlags & STATE_IS_WINDOW)
      this._callOnLoad();
  },
  onStatusChange: function() {
    console.log('status change!');
  },

  QueryInterface: XPCOMUtils.generateQI([Ci.nsIWebProgressListener,
                                         Ci.nsISupportsWeakReference]),
};


////////////////////////////////////////////////////////////////////////////////
// Test parameters passed in via environment variables / command line
//
// The goal is to allow our unit tests to be run against varying server
// configurations, etc.
//
// We started out using environment variables, but now try to support command
// line arguments too.
//
// --test-name is a required argument currently.
const ENVIRON_MAPPINGS = [
  {
    name: 'emailAddress',
    envVar: 'GELAM_TEST_ACCOUNT',
    coerce: function (x) { return x; },
  },
  {
    name: 'password',
    envVar: 'GELAM_TEST_PASSWORD',
    coerce: function (x) { return x; },
  },
  {
    name: 'type',
    envVar: 'GELAM_TEST_ACCOUNT_TYPE',
    coerce: function (x) { return x; },
  },
  {
    name: 'slow',
    envVar: 'GELAM_TEST_ACCOUNT_SLOW',
    coerce: Boolean
  }
];
var TEST_PARAMS = {
  name: 'Baron von Testendude',
  emailAddress: 'testy@localhost',
  password: 'testy',
  slow: false,
  type: 'imap',

  defaultArgs: true
};

var TEST_NAME = null;
/**
 * Pull test name and arguments out of command-line and/or environment
 */
function populateTestParams() {
  let args = window.arguments[0].QueryInterface(Ci.nsICommandLine);

  TEST_NAME = args.handleFlagWithParam('test-name', false)
                .replace(/\.js$/, '');

  let environ = Cc["@mozilla.org/process/environment;1"]
                  .getService(Ci.nsIEnvironment);
  for each (let [, {name, envVar, coerce}] in Iterator(ENVIRON_MAPPINGS)) {
    let argval = args.handleFlagWithParam('test-param-' + name, false);
    if (argval) {
      TEST_PARAMS[name] = coerce(argval);
      console.log('command line:', name, TEST_PARAMS[name]);
      if (name !== 'type')
        TEST_PARAMS.defaultArgs = false;
    }
    else if (environ.exists(envVar)) {
      TEST_PARAMS[name] = coerce(environ.get(envVar));
      console.log('environment:', name, TEST_PARAMS[name]);
      if (name !== 'type')
        TEST_PARAMS.defaultArgs = false;
    }
  }
}
populateTestParams();

////////////////////////////////////////////////////////////////////////////////
// make device storage operate out of our test-profile dir!
//
// We want any device storage tests to stick inside our test sub-directory and
// not be affected by our affect anywhere else on the disk.
//
// See the constants in:
// http://mxr.mozilla.org/mozilla-central/source/xpcom/io/nsDirectoryServiceDefs.h#54
// and their usages in nsDeviceStorage.cpp
//
// Note that DeviceStorage does support a "device.storage.testing" pref, but
// then it just makes a subdirectory of the temp directory, which limits
// our ability to test orthogonal device storages, etc.

var dirService = Cc["@mozilla.org/file/directory_service;1"]
                   .getService(Ci.nsIProperties);
var DEVICE_STORAGE_PATH_CLOBBERINGS = {
  // Linux:
  'XDGPict': 'pictures',
  'XDGMusic': 'music',
  'XDGVids': 'videos',
  // OSX:
  'Pct': 'pictures',
  'Music': 'music',
  'Mov': 'videos',
  // Win:
  'Pict': 'pictures',
  'Music': 'music',
  'Vids': 'videos'
};

var deviceStorageFile = dirService.get('ProfD', Ci.nsILocalFile);
deviceStorageFile.append('device-storage');

  /*
let replacementDirServiceProvider = {
  getFile: function(prop, persistent) {
    persistent.value = true;
    if (DEVICE_STORAGE_PATH_CLOBBERINGS.hasOwnProperty(prop))
      return deviceStorageFile.clone();

    return dirService.getFile(prop, persistent);
  },
  'get': function(prop, iid) {
    return dirService.get(prop, iid);
  },
  'set': function(prop, value) {
    return dirService.set(prop, value);
  },
  'has': function(prop) {

  },
  QueryInterface: XPCOMUtils.generateQI(
                    [Ci.nsIDirectoryService, Ci.nsIProperties]),
};
Components.manager
  .QueryInterface(Ci.nsIComponentRegistrar)
  .registerFactory(Components.ID('{753e01a4-dc3c-48c7-b45e-91544ec01302}'),
                   'fake directory service',
                   '@mozilla.org/file/directory_service;1',
                   replacementDirServiceProvider);
*/

for (let name in DEVICE_STORAGE_PATH_CLOBBERINGS) {
  // force an undefine
  try {
    dirService.undefine(name);
  }
  catch(ex) {}
  dirService.set(name, deviceStorageFile);
//console.log('after', name, dirService.get(name, Ci.nsILocalFile).path);
}

////////////////////////////////////////////////////////////////////////////////

const appStartup = Cc['@mozilla.org/toolkit/app-startup;1']
                     .getService(Ci.nsIAppStartup);
function quitApp() {
  appStartup.quit(Ci.nsIAppStartup.eForceQuit);
}

function buildQuery(args) {
  var bits = [];
  for (var key in args) {
    bits.push(encodeURIComponent(key) + "=" + encodeURIComponent(args[key]));
  }
  return bits.join("&");
};


var gRunnerIframe,
    gRunnerWindow;

// copied from our webapp.manifest
var EMAIL_PERMISSIONS = {
    "alarms":{},
    "audio-channel-notification":{},
    "contacts":{ "access": "readcreate" },
    "desktop-notification":{},
    "device-storage:sdcard":{ "access": "readcreate" },
    "systemXHR":{},
    "settings":{ "access": "readonly" },
    "tcp-socket":{}
};

function grantEmailPermissions(originUrl) {
  var perm = Cc["@mozilla.org/permissionmanager;1"]
               .createInstance(Ci.nsIPermissionManager);
  var uri = URI(originUrl, null, null);
  for (var permName in EMAIL_PERMISSIONS) {
    perm.add(uri, permName, 1);
  }
}

/**
 * For time/simplicity reasons, we aren't actually doing any type of async
 * proxying here but are instead favoring a synchronous API we are able to
 * expose directly into the content space.
 *
 * In a fancy async implementation, TestActiveSyncServerMixins could be made to
 * generate expectations to cover any async behaviour we started exhibiting.
 */
function ActiveSyncServerProxy() {
  this.server = null;

}
ActiveSyncServerProxy.prototype = {
  __exposedProps__: {
    createServer: 'r',
    addFolder: 'r',
    addMessageToFolder: 'r',
    addMessagesToFolder: 'r',
    useLoggers: 'r',
  },

  createServer: function(useDate) {
    this.server = new ActiveSyncServer(useDate);
    this.server.start(0);

    var httpServer = this.server.server,
        port = httpServer._socket.port;

    httpServer._port = port;
    // it had created the identity on port 0, which is not helpful to anyone
    httpServer._identity._initialize(port, httpServer._host, true);

    return {
      id: 'only',
      port: port
    };
  },

  addFolder: function(serverHandle, name, type, parentId, messageSetDef) {
    var folder = this.server.addFolder(name, type, parentId, messageSetDef);
    return folder.id;
  },

  addMessageToFolder: function(serverHandle, folderId, messageDef) {
    var folder = this.server.foldersById[folderId];
    folder.addMessage(messageDef);
  },

  addMessagesToFolder: function(serverHandle, folderId, messageSetDef) {
    var folder = this.server.foldersById[folderId];

  },

  useLoggers: function(serverHandle, loggers) {
    this.server.logRequest = loggers.request || null;
    this.server.logRequestBody = loggers.requestBody || null;
    this.server.logResponse = loggers.response || null;
    this.server.logResponseError  = loggers.responseError || null;
  },

  killServer: function() {
    if (!this.server)
      return;
    try {
      this.server.stop();
    }
    catch (ex) {
      console.error('Problem shutting down ActiveSync server:\n',
                    ex, '\n', ex.stack);
    }
    this.server = null;
  },

  cleanup: function() {
    this.killServer();
  }
};

function runTestFile(testFileName) {
  console.log('running', testFileName);

  var passToRunner = {
    testName: testFileName,
    testParams: JSON.stringify(TEST_PARAMS)
  };

  // Our testfile protocol allows us to use the test file as an origin, so every
  // test file gets its own instance of the e-mail database.  This is better
  // than deleting the database every time because at the end of the run we
  // will have all the untouched IndexedDB databases around so we can poke at
  // them if we need/want.
  var baseUrl = 'testfile://' + testFileName + '/';
  grantEmailPermissions(baseUrl);

  gRunnerIframe.setAttribute(
    'src', baseUrl + 'test/loggest-runner.html?' + buildQuery(passToRunner));
  console.log('src set to:', gRunnerIframe.getAttribute('src'));

  var win = gRunnerWindow = gRunnerIframe.contentWindow,
      domWin = win.wrappedJSObject;

  win.addEventListener('DOMContentLoaded', function() {
    console.log('iframe claims load complete');
  });

  var deferred = Promise.defer();

  var cleanupList = [];
  function cleanupWindow() {
    win.removeEventListener('error', errorListener);

    cleanupList.forEach(function(obj) {
      obj.cleanup();
    });
  }

  var webProgress = gRunnerIframe.webNavigation
                      .QueryInterface(Ci.nsIWebProgress);
  var progressListener = new ProgressListener(function() {
    webProgress.removeProgressListener(progressListener,
                                       Ci.nsIWebProgress.NOTIFY_STATE_WINDOW);

    // Look like we are content-space that embedded the iframe!
    domWin.parent = {
      __exposedProps__: {
        postMessage: 'r',
      },
      postMessage: function(data, dest) {
console.log('cleaning up window');
        cleanupWindow();
console.log('calling writeTestLog and resolving');
        writeTestLog(testFileName, data.data).then(function() {
          console.log('write completed!');
          deferred.resolve();
        });
      }
    };

    // XXX ugly magic bridge to allow creation of/control of fake ActiveSync
    // servers.
    var asProxy = new ActiveSyncServerProxy();
    domWin.MAGIC_SERVER_CONTROL = asProxy;
    cleanupList.push(asProxy);
  });
  webProgress.addProgressListener(progressListener,
                                  Ci.nsIWebProgress.NOTIFY_STATE_WINDOW);

  var errorListener = function errorListener(errorMsg, url, lineNumber) {
    console.error('win err:', errorMsg, url, lineNumber);
  };

  win.addEventListener('error', errorListener);

  return deferred.promise;
}

function writeTestLog(testFileName, jsonnableObj) {
  try {
    var encoder = new TextEncoder();
    var logFilename = testFileName + '.log';
    var logPath = do_get_file('test-logs/' + TEST_PARAMS.type).path +
                  '/' + logFilename;
    console.log('writing to', logPath);
    var str = '##### LOGGEST-TEST-RUN-BEGIN #####\n' +
          JSON.stringify(jsonnableObj) + '\n' +
          '##### LOGGEST-TEST-RUN-END #####\n';
    var arr = encoder.encode(str);
    return OS.File.writeAtomic(logPath, arr, { tmpPath: logPath + '.tmp' });
  }
  catch (ex) {
    console.error('Error trying to write log to disk!', ex, '\n', ex.stack);
    return null;
  }
}

function DOMLoaded() {
  gRunnerIframe = document.getElementById('runner');
  runTestFile(TEST_NAME).then(function() {
    console.log('test run completed, quitting');
    quitApp();
  });
}

} catch (ex) {
  dump('loggest-chrome-runner serious error: ' + ex + '\n' + ex.stack + '\n');
}
