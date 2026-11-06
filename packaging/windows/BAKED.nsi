; baked NSIS installer
;
; Per-user, no-admin installer following the Bun / Deno / OpenCode pattern:
;   - Installs to %LOCALAPPDATA%\Programs\baked
;   - Adds the install dir to the User PATH (idempotent, user-path.ps1)
;   - Registers under HKCU\…\Uninstall (visible in Settings → Apps)
;   - Start Menu shortcut for "baked" and "Uninstall"
;   - Kills any running baked.exe before overwriting (Windows file lock)
;
; Inputs (passed via /D defines from scripts/build-installer.ps1):
;   /DVERSION=<x.y.z>             — embedded in installer metadata
;   /DBUNDLE_DIR=<path>           — staged bundle (baked.exe + deps\)
;   /DOUTPUT=<path\setup.exe>     — output installer path
;   /DARCH=<x64|arm64>            — informational, recorded in registry
;
; Build:
;   makensis -DVERSION=2.15.3 -DBUNDLE_DIR=dist\bundle\baked-2.15.3-windows-x64 ^
;            -DOUTPUT=dist\bundle\baked-setup-2.15.3-x64.exe -DARCH=x64 ^
;            packaging\windows\baked.nsi
;
; No third-party plugins. PATH editing used the EnVar plugin until #2864: on a
; Windows 11 laptop, 60 install/uninstall cycles gave one installer busy-loop
; hang past EnVar::AddValue and two uninstaller access violations in ntdll, and
; EnVar was the plugin code both had run. user-path.ps1 (embedded, run from
; $PLUGINSDIR) edits HKCU\Environment\Path instead; the broadcast below has a
; 5 s timeout so a window that never answers cannot hang the installer.

!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!ifndef BUNDLE_DIR
  !error "BUNDLE_DIR must be defined (path to the staged bundle directory)"
!endif
!ifndef OUTPUT
  !define OUTPUT "baked-setup.exe"
!endif
!ifndef ARCH
  !define ARCH "x64"
!endif

!define APP_NAME      "baked"
!define APP_PUBLISHER "baked"
!define APP_URL       "https://github.com/baked/baked"
!define APP_EXE       "baked.exe"
!define UNINST_KEY    "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}"

Name "${APP_NAME} ${VERSION}"
OutFile "${OUTPUT}"
Unicode true
SetCompressor /SOLID lzma

; Per-user install — no admin elevation. Mirrors Bun/Deno install pattern.
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\${APP_NAME}"
InstallDirRegKey HKCU "Software\${APP_NAME}" "InstallDir"

; Embed version metadata in the PE header so SmartScreen / right-click →
; Properties shows correct identity.
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName"     "${APP_NAME}"
VIAddVersionKey "CompanyName"     "${APP_PUBLISHER}"
VIAddVersionKey "FileDescription" "${APP_NAME} installer"
VIAddVersionKey "FileVersion"     "${VERSION}"
VIAddVersionKey "ProductVersion"  "${VERSION}"

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "WinMessages.nsh"

!define MUI_ABORTWARNING
; MUI_ICON / MUI_UNICON intentionally omitted — NSIS expects a standalone
; .ico file, not a PE binary. Bun-compiled baked.exe has its icon
; resource embedded, which `Error while loading icon ... invalid icon file`
; on parse. NSIS falls back to its default installer icon. Add/Remove
; Programs still gets our exe's icon via DisplayIcon below.

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

Section "Install"
  SetOutPath "$INSTDIR"

  ; Kill any running baked.exe — Windows holds an exclusive lock and
  ; the file copy would fail mid-install otherwise.
  nsExec::Exec 'taskkill /F /IM ${APP_EXE} /T'
  Pop $0  ; discard exit code

  ; Stage the bundle. BUNDLE_DIR has baked.exe at root + deps\ alongside.
  File "${BUNDLE_DIR}\${APP_EXE}"
  File /r "${BUNDLE_DIR}\deps"
  File /nonfatal "${BUNDLE_DIR}\README.txt"

  ; "sf" PATH alias — copy of baked.exe so users get both `baked`
  ; and `sf` from any shell. Same binary, same runtime self-heal path,
  ; argv[0]-based detection elsewhere keeps logs consistent.
  CopyFiles /SILENT "$INSTDIR\${APP_EXE}" "$INSTDIR\sf.exe"

  ; Persist install dir + arch for the uninstaller / upgrade path.
  WriteRegStr HKCU "Software\${APP_NAME}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\${APP_NAME}" "Version"    "${VERSION}"
  WriteRegStr HKCU "Software\${APP_NAME}" "Arch"       "${ARCH}"

  ; Add install dir to User PATH (idempotent, keeps REG_EXPAND_SZ), then tell
  ; running programs so freshly-opened shells see it without a logoff (#2864).
  InitPluginsDir
  File "/oname=$PLUGINSDIR\user-path.ps1" "${__FILEDIR__}\user-path.ps1"
  nsExec::Exec '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\user-path.ps1" add "$INSTDIR"'
  Pop $0
  ${If} $0 != 0
    DetailPrint "warning: user-path.ps1 add returned $0 (PATH not updated)"
  ${EndIf}
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000

  ; Add uninstaller entry in Settings → Apps.
  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr   HKCU "${UNINST_KEY}" "DisplayName"     "${APP_NAME}"
  WriteRegStr   HKCU "${UNINST_KEY}" "DisplayVersion"  "${VERSION}"
  WriteRegStr   HKCU "${UNINST_KEY}" "Publisher"       "${APP_PUBLISHER}"
  WriteRegStr   HKCU "${UNINST_KEY}" "URLInfoAbout"    "${APP_URL}"
  WriteRegStr   HKCU "${UNINST_KEY}" "DisplayIcon"     "$INSTDIR\${APP_EXE}"
  WriteRegStr   HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr   HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify"        1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair"        1

  ; Start Menu shortcut (per-user — no admin needed).
  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortcut  "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}"
  CreateShortcut  "$SMPROGRAMS\${APP_NAME}\Uninstall.lnk"   "$INSTDIR\uninstall.exe"
SectionEnd

Section "Uninstall"
  ; Kill any running instance before deleting files (Windows holds an
  ; exclusive lock while the .exe is mapped).
  nsExec::Exec 'taskkill /F /IM ${APP_EXE} /T'
  Pop $0

  ; Strip install dir from User PATH (no-op if already absent).
  InitPluginsDir
  File "/oname=$PLUGINSDIR\user-path.ps1" "${__FILEDIR__}\user-path.ps1"
  nsExec::Exec '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\user-path.ps1" remove "$INSTDIR"'
  Pop $0
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000

  RMDir /r "$INSTDIR\deps"
  Delete   "$INSTDIR\${APP_EXE}"
  Delete   "$INSTDIR\sf.exe"
  Delete   "$INSTDIR\README.txt"
  Delete   "$INSTDIR\uninstall.exe"
  RMDir    "$INSTDIR"

  Delete   "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"
  Delete   "$SMPROGRAMS\${APP_NAME}\Uninstall.lnk"
  RMDir    "$SMPROGRAMS\${APP_NAME}"

  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "Software\${APP_NAME}"

  ; Per-user data dir (config, sessions, addons under installs/) lives under
  ; %LOCALAPPDATA%\baked. Offer to remove it so addons + config don't
  ; orphan after uninstall. Default = No (preserves data on accidental
  ; uninstall + reinstall flows).
  MessageBox MB_YESNO|MB_DEFBUTTON2|MB_ICONQUESTION \
    "Also remove baked config + addons under $LOCALAPPDATA\${APP_NAME}?$\r$\n$\r$\n(Choose No to keep your settings, sessions, and installed addons.)" \
    /SD IDNO IDNO skip_userdata
    RMDir /r "$LOCALAPPDATA\${APP_NAME}"
  skip_userdata:
SectionEnd
