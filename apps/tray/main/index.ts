// Electron main process — owns the tray icon, the popover window, the bearer token,
// and all HTTP/SSE traffic to apps/api.
//
// Renderer NEVER makes HTTP calls (see ARCHITECTURE.md § Electron CORS strategy r2);
// all API access goes through the IPC bridge defined in `ipc.ts`.

import { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { registerIpcHandlers } from './ipc.js';
import { initAuth, getBearerToken } from './auth.js';
import { connectSyncStream } from './sync.js';
import { buildTrayMenu } from './menu.js';

const isDev = process.env.NODE_ENV === 'development';

let tray: Tray | null = null;
let popoverWindow: BrowserWindow | null = null;

function createPopover(): BrowserWindow {
  const win = new BrowserWindow({
    width: 360,
    height: 460,
    show: false,
    frame: false,
    resizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: process.platform === 'darwin',
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs Node access for ipcRenderer
      webSecurity: true,
      devTools: isDev,
    },
  });

  if (isDev) {
    win
      .loadURL('http://localhost:5173')
      .catch((err) => console.error('Failed to load renderer in dev', err));
  } else {
    win
      .loadFile(join(__dirname, '..', 'renderer', 'dist', 'index.html'))
      .catch((err) => console.error('Failed to load renderer', err));
  }

  win.on('blur', () => {
    if (!isDev) {
      win.hide();
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    // External links open in the OS browser, not inside the popover.
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  return win;
}

function togglePopover() {
  if (!popoverWindow) return;
  if (popoverWindow.isVisible()) {
    popoverWindow.hide();
    return;
  }
  if (tray) {
    const trayBounds = tray.getBounds();
    const { width: winWidth } = popoverWindow.getBounds();
    const x = Math.round(trayBounds.x + trayBounds.width / 2 - winWidth / 2);
    const y = Math.round(trayBounds.y + (process.platform === 'darwin' ? trayBounds.height : -440));
    popoverWindow.setPosition(x, y, false);
  }
  popoverWindow.show();
  popoverWindow.focus();
}

function buildTrayIcon(): Electron.NativeImage {
  // 16x16 transparent base. In a real build the PNG assets live in main/tray-icons.
  // We embed a trivial fallback so the tray works in dev even before assets are dropped in.
  return nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAQAAAC1+jfqAAAAFklEQVR42mNk+M9ABMxAACgAYwwBkQAAAABJRU5ErkJggg==',
  );
}

async function bootstrap() {
  await app.whenReady();

  // Single-instance lock so two trays cannot fight over the timer.
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }

  app.setAppUserModelId('com.harvoost.tray');

  // Register the custom URI scheme for OIDC callbacks (harvoost://auth/callback).
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient('harvoost', process.execPath, [
        join(process.cwd(), process.argv[1] ?? ''),
      ]);
    }
  } else {
    app.setAsDefaultProtocolClient('harvoost');
  }

  initAuth();
  popoverWindow = createPopover();
  registerIpcHandlers(popoverWindow);

  tray = new Tray(buildTrayIcon());
  tray.setToolTip('Harvoost — click to clock in/out');
  tray.on('click', togglePopover);
  tray.on('right-click', () => {
    if (!tray) return;
    const menu = Menu.buildFromTemplate(buildTrayMenu(togglePopover));
    tray.popUpContextMenu(menu);
  });

  // Connect to the SSE sync stream if we already have a token; otherwise wait.
  const token = await getBearerToken();
  if (token) {
    connectSyncStream(token, popoverWindow);
  }

  // Forward second-instance launches as protocol-handler events (Windows).
  app.on('second-instance', (_event, argv) => {
    const url = argv.find((arg) => arg.startsWith('harvoost://'));
    if (url) {
      ipcMain.emit('harvoost:protocol-url', null, url);
    }
    if (popoverWindow) {
      togglePopover();
    }
  });

  app.on('open-url', (event, url) => {
    event.preventDefault();
    ipcMain.emit('harvoost:protocol-url', null, url);
  });
}

app.on('window-all-closed', (event: Electron.Event) => {
  // Tray app stays alive even when all windows are closed.
  event.preventDefault();
});

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Failed to bootstrap Harvoost tray', err);
  app.exit(1);
});
