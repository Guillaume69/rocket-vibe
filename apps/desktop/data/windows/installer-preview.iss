; The installer's look without installing the app: the same wizard
; (installer-ui.iss) over a throwaway payload, copied to a temporary folder
; and deleted at the end; no shortcut, registry key or uninstaller.
;   ISCC /DPayload=<folder of any files> /O<output dir> installer-preview.iss
; A few hundred megabytes of payload leave time to watch the rocket fly.

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
Uninstallable=no
CreateUninstallRegKey=no
PrivilegesRequired=lowest
OutputBaseFilename=rocket-vibe-installer-preview
SetupIconFile=rocket-vibe.ico
Compression=none

#include "installer-ui.iss"

[Files]
Source: "{#Payload}\*"; DestDir: "{app}"; Flags: ignoreversion deleteafterinstall
