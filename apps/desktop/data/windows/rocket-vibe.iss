; Windows installer for the desktop app, built by Inno Setup 6 in CI:
;   ISCC /DAppVersion=<x.y.z> /DSourceDir=<package folder> /O<output dir> rocket-vibe.iss
; The package folder is what scripts/package-windows.sh lays out (bin, lib, share).

#ifndef AppVersion
  #error AppVersion is required
#endif
#ifndef SourceDir
  #error SourceDir is required
#endif

[Setup]
AppId={{6C3F7A2E-9B41-4E57-8D2A-5F0B1C7E4A93}
AppName=rocket-vibe
AppVersion={#AppVersion}
AppPublisher=rocket-vibe
AppPublisherURL=https://github.com/Guillaume69/rocket-vibe
DefaultDirName={autopf}\rocket-vibe
DefaultGroupName=rocket-vibe
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputBaseFilename=rocket-vibe-desktop-{#AppVersion}-windows-x86_64-setup
SetupIconFile=rocket-vibe.ico
UninstallDisplayIcon={app}\rocket-vibe.ico
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"
Name: "fr"; MessagesFile: "compiler:Languages\French.isl"

[Files]
; The whole package folder, bin\rv-voice.exe (the voice sidecar) included: it
; must stay next to bin\rocket-vibe-gtk.exe, where the app looks for it.
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "rocket-vibe.ico"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\rocket-vibe"; Filename: "{app}\bin\rocket-vibe-gtk.exe"; WorkingDir: "{app}\bin"; IconFilename: "{app}\rocket-vibe.ico"; AppUserModelID: "com.rocketvibe.app"; AppUserModelToastActivatorCLSID: "83B10F7C-B85B-4A2A-A67E-0C8DC7D71C53"
Name: "{autodesktop}\rocket-vibe"; Filename: "{app}\bin\rocket-vibe-gtk.exe"; WorkingDir: "{app}\bin"; IconFilename: "{app}\rocket-vibe.ico"; AppUserModelID: "com.rocketvibe.app"; AppUserModelToastActivatorCLSID: "83B10F7C-B85B-4A2A-A67E-0C8DC7D71C53"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Registry]
; Per-user COM callback for clicks/replies after the original process exits.
Root: HKCU; Subkey: "Software\Classes\CLSID\{{83B10F7C-B85B-4A2A-A67E-0C8DC7D71C53}"; ValueType: none; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\CLSID\{{83B10F7C-B85B-4A2A-A67E-0C8DC7D71C53}\LocalServer32"; ValueType: string; ValueName: ""; ValueData: """{app}\bin\rocket-vibe-gtk.exe"" -ToastActivated"
Root: HKCU; Subkey: "Software\Classes\AppUserModelId\com.rocketvibe.app"; ValueType: string; ValueName: "CustomActivator"; ValueData: "{{83B10F7C-B85B-4A2A-A67E-0C8DC7D71C53}"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\AppUserModelId\com.rocketvibe.app"; ValueType: string; ValueName: "DisplayName"; ValueData: "rocket-vibe"
Root: HKCU; Subkey: "Software\Classes\AppUserModelId\com.rocketvibe.app"; ValueType: string; ValueName: "IconUri"; ValueData: "{app}\rocket-vibe.ico"
Root: HKCU; Subkey: "Software\Classes\rocketvibe"; ValueType: string; ValueName: ""; ValueData: "URL:rocketvibe"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\rocketvibe"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKCU; Subkey: "Software\Classes\rocketvibe\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: """{app}\rocket-vibe.ico"""
; Written by the app's "Start at login" switch; gone with the app.
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: none; ValueName: "rocket-vibe"; Flags: uninsdeletevalue dontcreatekey
Root: HKCU; Subkey: "Software\Classes\rocketvibe\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\bin\rocket-vibe-gtk.exe"" ""%1"""

[Run]
Filename: "{app}\bin\rocket-vibe-gtk.exe"; WorkingDir: "{app}\bin"; Description: "{cm:LaunchProgram,rocket-vibe}"; Flags: nowait postinstall skipifsilent
; The app's own updater runs this installer silently with /relaunch=1 and quits.
Filename: "{app}\bin\rocket-vibe-gtk.exe"; WorkingDir: "{app}\bin"; Flags: nowait; Check: Relaunch

[Code]
function Relaunch: Boolean;
begin
  Result := ExpandConstant('{param:relaunch|0}') = '1';
end;
