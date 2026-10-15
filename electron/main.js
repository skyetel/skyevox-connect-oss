const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, Notification, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { isFileWithinRoots } = require('./security');
const { DiagnosticLogWriter } = require('./diagnostic-log');
const { AUTOPLAY_POLICY, createWebPreferences } = require('./window-options');

let mainWindow = null;
let tray = null;
let isQuitting = false;
let diagnosticLogWriter = null;

const defaultSettings = {
  windowBounds: { width: 380, height: 700 },
  minimizeToTray: true,
  autoStart: false,
};

const storageKeyPattern = /^[a-zA-Z0-9_.:-]+$/;

function writeStartupError(error) {
  try {
    const message = error && error.stack ? error.stack : String(error);
    const logPath = path.join(app.getPath('userData'), 'main-process-error.log');
    fs.appendFileSync(logPath, `[${new Date().toISOString()}]\n${message}\n\n`);
  } catch (_logError) {
    // Avoid throwing while handling a startup failure.
  }
}

function getDiagnosticLogPath() {
  return path.join(app.getPath('userData'), 'skyevox-connect-diagnostics.log');
}

function getDiagnosticLogWriter() {
  if (!diagnosticLogWriter) {
    diagnosticLogWriter = new DiagnosticLogWriter({
      filePath: getDiagnosticLogPath(),
      onError: writeStartupError,
    });
  }
  return diagnosticLogWriter;
}

function writeRendererLog(level, message, data) {
  return getDiagnosticLogWriter().write(level, message, data);
}

process.on('uncaughtException', (error) => {
  writeStartupError(error);
  console.error(error);
});

process.on('unhandledRejection', (error) => {
  writeStartupError(error);
  console.error(error);
});

class LocalSettingsStore {
  constructor(defaults) {
    this.defaults = defaults;
    this.data = null;
  }

  get filePath() {
    return path.join(app.getPath('userData'), 'settings.json');
  }

  load() {
    if (this.data) {
      return this.data;
    }

    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      this.data = { ...this.defaults, ...JSON.parse(raw) };
    } catch (_error) {
      this.data = { ...this.defaults };
    }

    return this.data;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.load(), null, 2));
    } catch (error) {
      writeStartupError(error);
    }
  }

  get(key) {
    return this.load()[key];
  }

  set(key, value) {
    this.load()[key] = value;
    this.save();
  }
}

const store = new LocalSettingsStore(defaultSettings);
const userStorage = new LocalSettingsStore({});

app.commandLine.appendSwitch('autoplay-policy', AUTOPLAY_POLICY);

function assertStorageKey(key) {
  if (typeof key !== 'string' || !storageKeyPattern.test(key)) {
    throw new Error('Invalid storage key');
  }
}

function resolveResourcePath(...segments) {
  const candidates = [
    path.join(process.resourcesPath || '', ...segments),
    path.join(__dirname, '..', ...segments),
  ];

  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

function getIconPath(size) {
  return resolveResourcePath('chrome-extension', 'icons', `icon${size}.png`);
}

function getTrustedAppRoots() {
  return [
    path.join(process.resourcesPath || '', 'app'),
    path.join(__dirname, '..', 'dist'),
  ];
}

function isTrustedRenderer(webContents, frameUrl) {
  return Boolean(
    mainWindow
    && webContents === mainWindow.webContents
    && isFileWithinRoots(frameUrl || webContents.getURL(), getTrustedAppRoots()),
  );
}

function requireTrustedIpcSender(event) {
  if (!isTrustedRenderer(event.sender, event.senderFrame?.url)) {
    throw new Error('Rejected IPC request from an untrusted renderer');
  }
}

function loadIcon(size) {
  const iconPath = getIconPath(size);
  if (!iconPath) {
    return null;
  }

  const icon = nativeImage.createFromPath(iconPath);
  return icon.isEmpty() ? null : icon;
}

function createWindow() {
  const { width, height } = store.get('windowBounds');
  const windowIcon = getIconPath(128);

  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: 320,
    minHeight: 600,
    maxWidth: 500,
    resizable: true,
    ...(windowIcon ? { icon: windowIcon } : {}),
    webPreferences: createWebPreferences(path.join(__dirname, 'preload.js')),
    title: 'SkyeVox Connect',
  });

  // Load the built web app
  const appPath = path.join(process.resourcesPath, 'app', 'index.html');
  mainWindow.loadFile(appPath).catch(() => {
    // Fallback for development
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  });

  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    if (!isFileWithinRoots(navigationUrl, getTrustedAppRoots())) {
      event.preventDefault();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  mainWindow.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });

  // Save window size on resize
  mainWindow.on('resize', () => {
    const [w, h] = mainWindow.getSize();
    store.set('windowBounds', { width: w, height: h });
  });

  // Minimize to tray on close (if enabled)
  mainWindow.on('close', (e) => {
    if (!isQuitting && store.get('minimizeToTray')) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function configureMediaPermissions() {
  session.defaultSession.setPermissionCheckHandler((webContents, permission, _origin, details) => {
    return permission === 'media'
      && details.isMainFrame
      && isTrustedRenderer(webContents, details.requestingUrl);
  });

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(
      permission === 'media'
      && details.isMainFrame
      && isTrustedRenderer(webContents, details.requestingUrl),
    );
  });
}

function createTray() {
  const icon = loadIcon(16);
  if (!icon) {
    return;
  }

  if (process.platform === 'darwin') {
    icon.setTemplateImage(true);
  }

  try {
    tray = new Tray(icon);
  } catch (error) {
    writeStartupError(error);
    console.error('Tray creation failed:', error);
    return;
  }

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show SkyeVox Connect',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setToolTip('SkyeVox Connect');
  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.focus();
      } else {
        mainWindow.show();
      }
    }
  });
}

// Handle deep links (skyevox:// protocol)
app.setAsDefaultProtocolClient('skyevox');

app.on('open-url', (_event, url) => {
  if (mainWindow) {
    mainWindow.webContents.send('deep-link', url);
    mainWindow.show();
    mainWindow.focus();
  }
});

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    // Handle deep link from second instance (Windows/Linux)
    const url = argv.find((arg) => arg.startsWith('skyevox://'));
    if (url && mainWindow) {
      mainWindow.webContents.send('deep-link', url);
    }
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

app.on('ready', () => {
  configureMediaPermissions();
  createWindow();
  createTray();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  } else {
    mainWindow.show();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
});

// IPC handlers

ipcMain.handle('notify-incoming-call', (event, name, number) => {
  requireTrustedIpcSender(event);
  if (Notification.isSupported()) {
    const icon = getIconPath(48);
    const notification = new Notification({
      title: 'Incoming Call',
      body: `${name || 'Unknown'} (${number})`,
      ...(icon ? { icon } : {}),
      urgency: 'critical',
    });
    notification.on('click', () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
    });
    notification.show();
  }

  // Flash taskbar
  if (mainWindow && !mainWindow.isFocused()) {
    mainWindow.flashFrame(true);
  }
});

ipcMain.handle('set-auto-start', (event, enabled) => {
  requireTrustedIpcSender(event);
  app.setLoginItemSettings({ openAtLogin: enabled });
  store.set('autoStart', enabled);
});

ipcMain.handle('set-minimize-to-tray', (event, enabled) => {
  requireTrustedIpcSender(event);
  store.set('minimizeToTray', enabled);
});

ipcMain.handle('get-settings', (event) => {
  requireTrustedIpcSender(event);
  return {
    autoStart: store.get('autoStart'),
    minimizeToTray: store.get('minimizeToTray'),
  };
});

ipcMain.handle('renderer-log', (event, level, message, data) => {
  requireTrustedIpcSender(event);
  return writeRendererLog(level, message, data);
});

ipcMain.handle('get-diagnostic-log-path', (event) => {
  requireTrustedIpcSender(event);
  return getDiagnosticLogPath();
});

ipcMain.handle('storage-get', (event, key) => {
  requireTrustedIpcSender(event);
  assertStorageKey(key);
  const value = userStorage.get(key);
  return typeof value === 'string' ? value : null;
});

ipcMain.handle('storage-set', (event, key, value) => {
  requireTrustedIpcSender(event);
  assertStorageKey(key);
  userStorage.set(key, String(value));
});

ipcMain.handle('storage-remove', (event, key) => {
  requireTrustedIpcSender(event);
  assertStorageKey(key);
  const data = userStorage.load();
  delete data[key];
  userStorage.save();
});
