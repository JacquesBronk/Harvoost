import { app, type MenuItemConstructorOptions } from 'electron';

export function buildTrayMenu(onOpen: () => void): MenuItemConstructorOptions[] {
  return [
    { label: 'Open Harvoost', click: onOpen },
    { type: 'separator' },
    {
      label: 'Quit',
      role: 'quit',
      accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Ctrl+Q',
      click: () => app.exit(0),
    },
  ];
}
