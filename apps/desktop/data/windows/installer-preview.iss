; The installer's look without installing the app: the same wizard
; (installer-ui.iss) over a throwaway payload, copied to a temporary folder;
; no shortcut and no registry key. Its uninstaller (unins000.exe in that
; folder, run by hand) shows the uninstall look and takes the folder away.
;   ISCC /DPayload=<folder of any files> /O<output dir> installer-preview.iss
; A few hundred megabytes leave time to watch the rocket fly, and a few
; thousand small files to watch it crash.

#ifndef Payload
  #error Payload is required
#endif

[Setup]
AppId=rocket-vibe-installer-preview
AppName=rocket-vibe
AppVersion=0.0.0-preview
DefaultDirName={%TEMP}\rocket-vibe-installer-preview
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=no
CreateUninstallRegKey=no
PrivilegesRequired=lowest
OutputBaseFilename=rocket-vibe-installer-preview
SetupIconFile=rocket-vibe.ico
Compression=none

#include "installer-ui.iss"

[Files]
Source: "{#Payload}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs
