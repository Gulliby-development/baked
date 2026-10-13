/**
 * The Windows app user model ID, the same as `appId` in electron-builder.yml. Set explicitly so
 * notifications carry it whatever Start menu shortcut launched the app.
 */
export const APP_USER_MODEL_ID = "dev.baked.desktop";

/**
 * The ID a run sets. An unpackaged run (`bun run dev`, `electron .`) is electron.exe, and Windows
 * gives it a Start menu shortcut with Electron's icon; sharing the installed app's ID would make
 * the taskbar show that icon for the installed app too.
 */
export function appUserModelId(packaged: boolean): string {
  return packaged ? APP_USER_MODEL_ID : `${APP_USER_MODEL_ID}.dev`;
}
