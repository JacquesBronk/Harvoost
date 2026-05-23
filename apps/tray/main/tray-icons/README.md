# Tray icons

This directory must contain platform-specific tray icons before packaging.
Electron-builder reads from here as `buildResources`.

Expected files (drop in before running `pnpm --filter @harvoost/tray package`):

- `icon.icns` — macOS app icon (1024×1024 multi-resolution).
- `icon.ico` — Windows app + tray icon (multi-resolution, includes 16, 32, 48, 256).
- `icon.png` — Linux app icon (512×512).
- `tray-mac.png` — 16×16 + 32×32 (`tray-mac@2x.png`) menu-bar template icon for macOS.
- `tray-win.png` — 16×16 + 32×32 (`tray-win@2x.png`) Windows notification-area icon.
- `tray-linux.png` — 22×22 + 44×44 (`tray-linux@2x.png`) Linux tray icon.

The main process falls back to a tiny embedded PNG if none of these exist so
the tray will still appear during dev. Replace before shipping.
