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
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "rocket-vibe.ico"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\rocket-vibe"; Filename: "{app}\bin\rocket-vibe-gtk.exe"; WorkingDir: "{app}\bin"; IconFilename: "{app}\rocket-vibe.ico"; AppUserModelID: "com.rocketvibe.app"
Name: "{autodesktop}\rocket-vibe"; Filename: "{app}\bin\rocket-vibe-gtk.exe"; WorkingDir: "{app}\bin"; IconFilename: "{app}\rocket-vibe.ico"; AppUserModelID: "com.rocketvibe.app"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Registry]
Root: HKCU; Subkey: "Software\Classes\rocketvibe"; ValueType: string; ValueName: ""; ValueData: "URL:rocketvibe"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\rocketvibe"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKCU; Subkey: "Software\Classes\rocketvibe\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: """{app}\rocket-vibe.ico"""
Root: HKCU; Subkey: "Software\Classes\rocketvibe\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\bin\rocket-vibe-gtk.exe"" ""%1"""

[Run]
Filename: "{app}\bin\rocket-vibe-gtk.exe"; WorkingDir: "{app}\bin"; Description: "{cm:LaunchProgram,rocket-vibe}"; Flags: nowait postinstall skipifsilent
