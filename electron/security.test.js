const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const { isFileWithinRoots } = require('./security');
const { AUTOPLAY_POLICY, createWebPreferences } = require('./window-options');
const packageJson = require('./package.json');

const appRoot = path.resolve('/tmp/skyevox-connect/app');

test('accepts a local file inside the packaged application root', () => {
  const url = pathToFileURL(path.join(appRoot, 'index.html')).href;
  assert.equal(isFileWithinRoots(url, [appRoot]), true);
});

test('rejects a sibling local file', () => {
  const url = pathToFileURL(path.resolve(appRoot, '..', 'outside.html')).href;
  assert.equal(isFileWithinRoots(url, [appRoot]), false);
});

test('rejects a remote origin', () => {
  assert.equal(isFileWithinRoots('https://example.com/', [appRoot]), false);
});

test('rejects malformed URLs', () => {
  assert.equal(isFileWithinRoots('not a url', [appRoot]), false);
});


test('desktop audio policy allows minimized incoming ringtone playback', () => {
  const preferences = createWebPreferences('/app/preload.js');
  assert.equal(AUTOPLAY_POLICY, 'no-user-gesture-required');
  assert.equal(preferences.backgroundThrottling, false);
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(preferences.sandbox, true);
});
test('packages every required main-process module', () => {
  const packagedFiles = new Set(packageJson.build.files);
  assert.equal(packagedFiles.has('security.js'), true);
  assert.equal(packagedFiles.has('window-options.js'), true);
  assert.equal(packagedFiles.has('call-park.js'), true);
});

test('Electron main applies ringtone playback policy to its actual BrowserWindow', () => {
  const Module = require('node:module');
  const originalLoad = Module._load;
  const mainPath = require.resolve('./main');
  const priorUncaught = new Set(process.listeners('uncaughtException'));
  const priorUnhandled = new Set(process.listeners('unhandledRejection'));
  const priorResourcesPath = process.resourcesPath;
  process.resourcesPath = '/tmp/skyevox-connect-resources';
  const appHandlers = new Map();
  const ipcHandlers = new Map();
  const switches = [];
  let browserWindowOptions;

  class FakeBrowserWindow {
    constructor(options) {
      browserWindowOptions = options;
      this.webContents = {
        getURL: () => '',
        on: () => {},
        send: () => {},
        setWindowOpenHandler: () => {},
      };
    }

    loadFile() {
      return Promise.resolve();
    }

    on() {}
  }

  const electron = {
    app: {
      commandLine: {
        appendSwitch: (name, value) => switches.push([name, value]),
      },
      getPath: () => '/tmp/skyevox-connect-test',
      on: (event, handler) => appHandlers.set(event, handler),
      quit: () => {},
      requestSingleInstanceLock: () => true,
      setAsDefaultProtocolClient: () => {},
    },
    BrowserWindow: FakeBrowserWindow,
    Tray: class {},
    Menu: { buildFromTemplate: () => ({}) },
    nativeImage: {
      createFromPath: () => ({
        isEmpty: () => true,
      }),
    },
    ipcMain: { handle: (channel, handler) => ipcHandlers.set(channel, handler) },
    Notification: class {},
    session: {
      defaultSession: {
        setPermissionCheckHandler: () => {},
        setPermissionRequestHandler: () => {},
      },
    },
  };

  Module._load = function load(request, parent, isMain) {
    if (request === 'electron') return electron;
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[mainPath];
    require(mainPath);
    appHandlers.get('ready')();

    assert.deepEqual(switches, [['autoplay-policy', 'no-user-gesture-required']]);
    assert.equal(browserWindowOptions.webPreferences.backgroundThrottling, false);
    assert.equal(browserWindowOptions.webPreferences.contextIsolation, true);
    assert.equal(browserWindowOptions.webPreferences.nodeIntegration, false);
    assert.equal(browserWindowOptions.webPreferences.sandbox, true);
    assert.equal(ipcHandlers.has('park-call'), false);
  } finally {
    Module._load = originalLoad;
    delete require.cache[mainPath];
    if (priorResourcesPath === undefined) {
      delete process.resourcesPath;
    } else {
      process.resourcesPath = priorResourcesPath;
    }
    for (const listener of process.listeners('uncaughtException')) {
      if (!priorUncaught.has(listener)) process.removeListener('uncaughtException', listener);
    }
    for (const listener of process.listeners('unhandledRejection')) {
      if (!priorUnhandled.has(listener)) process.removeListener('unhandledRejection', listener);
    }
  }
});
