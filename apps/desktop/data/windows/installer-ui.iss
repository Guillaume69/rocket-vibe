; The installer's look, shared by rocket-vibe.iss and installer-preview.iss:
; the app icon's night sky, a borderless window dragged from anywhere,
; pill buttons, and a rocket trailing a rainbow as the progress bar.
; installer-art.py draws the images. Needs Inno Setup 6.7 or later.

[Setup]
; Dark whatever the Windows theme: the art is.
WizardStyle=modern dark hidebevels
WizardBackColor=#1b1530
WizardBackImageFile=installer\back.png
WizardImageFile=installer\wizard-202x386.png,installer\wizard-336x643.png,installer\wizard-430x824.png
WizardSmallImageFile=installer\small-58.png,installer\small-97.png,installer\small-124.png
; The welcome page carries the rocket; Inno Setup hides it by default.
DisableWelcomePage=no
; The language picker is a system dialog with a frame: only when Windows'
; own language is none of ours.
ShowLanguageDialog=auto

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"
Name: "fr"; MessagesFile: "compiler:Languages\French.isl"

[Messages]
en.WelcomeLabel1=Ready for liftoff
en.WelcomeLabel2=[name/ver] is about to land on your computer: your Rocket.Chat, with good vibes.
en.InstallingLabel=Fueling up [name], hang tight...
en.FinishedHeadingLabel=Liftoff!
en.FinishedLabelNoIcons=[name] is installed and ready to fly.
en.FinishedLabel=[name] is installed and ready to fly. Find it any time from its shortcut.
en.UninstalledAll=%1 crash-landed in style. See you soon!
en.ButtonBack=Back
en.ButtonNext=Next
fr.WelcomeLabel1=Prêt au décollage
fr.WelcomeLabel2=[name/ver] s'apprête à se poser sur votre ordinateur : votre Rocket.Chat, en bonnes vibrations.
fr.InstallingLabel=On fait le plein de [name], encore un instant...
fr.FinishedHeadingLabel=Décollage !
fr.FinishedLabelNoIcons=[name] est installé et prêt à voler.
fr.FinishedLabel=[name] est installé et prêt à voler. Retrouvez-le à tout moment depuis son raccourci.
fr.UninstalledAll=%1 s'est écrasé en beauté. À bientôt !
fr.ButtonBack=Retour
fr.ButtonNext=Suivant

[Files]
Source: "installer\pill.png"; Flags: dontcopy
Source: "installer\rocket.png"; Flags: dontcopy
Source: "installer\rainbow.png"; Flags: dontcopy
Source: "installer\track.png"; Flags: dontcopy
; The uninstaller's copy: it cannot extract from Setup.
Source: "installer\rocket.png"; DestDir: "{app}\installer-art"; Flags: ignoreversion
Source: "installer\pill.png"; DestDir: "{app}\installer-art"; Flags: ignoreversion
Source: "installer\rainbow.png"; DestDir: "{app}\installer-art"; Flags: ignoreversion
Source: "installer\track.png"; DestDir: "{app}\installer-art"; Flags: ignoreversion
Source: "installer\back.png"; DestDir: "{app}\installer-art"; Flags: ignoreversion
Source: "installer\crash-*.png"; DestDir: "{app}\installer-art"; Flags: ignoreversion

[CustomMessages]
en.Crashed=Crash!
en.FarewellYes=Bye!
en.ConfirmTitle=Ground the rocket?
en.ConfirmText=This removes %1 and everything it brought along. The rocket will not survive the landing.
en.ConfirmYes=Uninstall
en.ConfirmNo=Keep it
en.AbortTitle=Abort the launch?
en.AbortText=%1 is not installed yet. Run Setup again any time to finish.
en.AbortYes=Abort
en.AbortNo=Keep going
fr.Crashed=Crash !
fr.FarewellYes=Salut !
fr.ConfirmTitle=Clouer la fusée au sol ?
fr.ConfirmText=Cela retire %1 et tout ce qu'il a apporté. La fusée ne survivra pas à l'atterrissage.
fr.ConfirmYes=Désinstaller
fr.ConfirmNo=La garder
fr.AbortTitle=Annuler le décollage ?
fr.AbortText=%1 n'est pas encore installé. Relancez l'installation quand vous voulez pour finir.
fr.AbortYes=Annuler
fr.AbortNo=Continuer

[Code]
const
  GWL_WNDPROC = -4;
  WM_NCHITTEST = $0084;
  BM_CLICK = $00F5;
  HTCLIENT = 1;
  HTCAPTION = 2;
  HTTRANSPARENT = -1;
  PILL_COLOR = $ffffff;
  GHOST_COLOR = $f0c8d8;

type
  TScreenPoint = record
    X, Y: Longint;
  end;

function SetWindowLong(Wnd: HWND; Index: Integer; NewLong: Longword): Longword;
  external 'SetWindowLongW@user32.dll stdcall';
function CallWindowProc(Proc: Longword; Wnd: HWND; Msg: Cardinal; WParam, LParam: Longint): Longint;
  external 'CallWindowProcW@user32.dll stdcall';
function ScreenToClient(Wnd: HWND; var Point: TScreenPoint): BOOL;
  external 'ScreenToClient@user32.dll stdcall';
function IsWindow(Wnd: HWND): BOOL;
  external 'IsWindow@user32.dll stdcall';

var
  { Windows whose hit test we answer, and their own window procedures. }
  Hooked: array of HWND;
  HookedProcs: array of Longword;
  HitTestCallback: Longword;
  NextPill: TBitmapImage;
  NextCaption, BackCaption, CancelCaption: TNewStaticText;
  Track, Rainbow, Rocket: TBitmapImage;
  { The lane, where the gauge was. }
  LaneLeft, LaneWidth: Integer;

function OwnProc(Wnd: HWND): Longword;
var
  I: Integer;
begin
  Result := 0;
  for I := 0 to GetArrayLength(Hooked) - 1 do
    if Hooked[I] = Wnd then
    begin
      Result := HookedProcs[I];
      Exit;
    end;
end;

function Inside(Control: TControl; X, Y: Integer): Boolean;
begin
  Result := Control.Visible and (X >= Control.Left) and (X < Control.Left + Control.Width) and
    (Y >= Control.Top) and (Y < Control.Top + Control.Height);
end;

{ No title bar to hold: the window's own background drags it, and the panels
  and pages over it let the hit test through to it. Controls keep theirs. }
function HitTest(Wnd: HWND; Msg: Cardinal; WParam, LParam: Longint): Longint;
var
  Point: TScreenPoint;
begin
  Result := CallWindowProc(OwnProc(Wnd), Wnd, Msg, WParam, LParam);
  if (Msg <> WM_NCHITTEST) or (Result <> HTCLIENT) then
    Exit;
  if Wnd <> WizardForm.Handle then
  begin
    Result := HTTRANSPARENT;
    Exit;
  end;
  Point.X := LParam and $FFFF;
  if Point.X > $7FFF then
    Point.X := Point.X - $10000;
  Point.Y := (LParam shr 16) and $FFFF;
  if Point.Y > $7FFF then
    Point.Y := Point.Y - $10000;
  ScreenToClient(Wnd, Point);
  if not (Inside(NextPill, Point.X, Point.Y) or Inside(NextCaption, Point.X, Point.Y) or
    Inside(BackCaption, Point.X, Point.Y) or Inside(CancelCaption, Point.X, Point.Y)) then
    Result := HTCAPTION;
end;

procedure Hook(Control: TWinControl);
var
  I: Integer;
begin
  I := GetArrayLength(Hooked);
  SetArrayLength(Hooked, I + 1);
  SetArrayLength(HookedProcs, I + 1);
  Hooked[I] := Control.Handle;
  HookedProcs[I] := SetWindowLong(Control.Handle, GWL_WNDPROC, HitTestCallback);
end;

procedure HookDragging;
var
  I: Integer;
begin
  HitTestCallback := CreateCallback(@HitTest);
  Hook(WizardForm);
  Hook(WizardForm.OuterNotebook);
  Hook(WizardForm.InnerNotebook);
  Hook(WizardForm.MainPanel);
  for I := 0 to WizardForm.OuterNotebook.PageCount - 1 do
    Hook(WizardForm.OuterNotebook.Pages[I]);
  for I := 0 to WizardForm.InnerNotebook.PageCount - 1 do
    Hook(WizardForm.InnerNotebook.Pages[I]);
  { Texts are windows of their own: they let the drag through too. }
  Hook(WizardForm.WelcomeLabel1);
  Hook(WizardForm.WelcomeLabel2);
  Hook(WizardForm.FinishedHeadingLabel);
  Hook(WizardForm.FinishedLabel);
  Hook(WizardForm.PageNameLabel);
  Hook(WizardForm.PageDescriptionLabel);
  Hook(WizardForm.ReadyLabel);
  Hook(WizardForm.StatusLabel);
  Hook(WizardForm.FilenameLabel);
end;

{ Gives every window its own procedure back before the script goes away. }
procedure UnhookDragging;
var
  I: Integer;
begin
  for I := 0 to GetArrayLength(Hooked) - 1 do
    if IsWindow(Hooked[I]) then
      SetWindowLong(Hooked[I], GWL_WNDPROC, HookedProcs[I]);
  SetArrayLength(Hooked, 0);
end;

function Png(const Name: String): String;
begin
  ExtractTemporaryFile(Name);
  Result := ExpandConstant('{tmp}\' + Name);
end;

procedure Press(Button: TNewButton);
begin
  if Button.Visible and Button.Enabled then
    PostMessage(Button.Handle, BM_CLICK, 0, 0);
end;

procedure NextClick(Sender: TObject);
begin
  Press(WizardForm.NextButton);
end;

procedure BackClick(Sender: TObject);
begin
  Press(WizardForm.BackButton);
end;

procedure CancelClick(Sender: TObject);
begin
  Press(WizardForm.CancelButton);
end;

function MakeLabel(const Parent: TWinControl; Color: Integer; Click: TNotifyEvent): TNewStaticText;
begin
  Result := TNewStaticText.Create(Parent);
  Result.Parent := Parent;
  Result.AutoSize := True;
  Result.ShowAccelChar := False;
  Result.Font.Color := Color;
  Result.Font.Size := 10;
  Result.Font.Style := [fsBold];
  Result.Cursor := crHand;
  Result.OnClick := Click;
end;

{ The real buttons leave the window but stay on duty, for Enter, Escape and
  Setup's own logic; what shows is a pill and two plain words. }
procedure MakeButtons;
var
  Height: Integer;
begin
  Height := WizardForm.NextButton.Height + ScaleY(8);
  NextPill := TBitmapImage.Create(WizardForm);
  NextPill.Parent := WizardForm;
  NextPill.Stretch := True;
  NextPill.BackColor := clNone;
  NextPill.PngImage.LoadFromFile(Png('pill.png'));
  NextPill.Height := Height;
  NextPill.Width := Height * 288 div 80;
  NextPill.Left := WizardForm.CancelButton.Left + WizardForm.CancelButton.Width - NextPill.Width;
  NextPill.Top := WizardForm.NextButton.Top - ScaleY(4);
  NextPill.Cursor := crHand;
  NextPill.OnClick := @NextClick;
  NextCaption := MakeLabel(WizardForm, PILL_COLOR, @NextClick);
  BackCaption := MakeLabel(WizardForm, GHOST_COLOR, @BackClick);
  CancelCaption := MakeLabel(WizardForm, GHOST_COLOR, @CancelClick);
end;

function Plain(const Text: String): String;
begin
  Result := Text;
  StringChangeEx(Result, '&', '', True);
end;

procedure Place(Text: TNewStaticText; Button: TNewButton; Right: Integer);
begin
  Text.Caption := Plain(Button.Caption);
  Text.Visible := Button.Visible and Button.Enabled;
  Text.Left := Right - Text.Width;
  Text.Top := NextPill.Top + (NextPill.Height - Text.Height) div 2;
end;

procedure SyncButtons;
begin
  WizardForm.NextButton.Top := -ScaleY(200);
  WizardForm.BackButton.Top := -ScaleY(200);
  WizardForm.CancelButton.Top := -ScaleY(200);
  NextPill.Visible := WizardForm.NextButton.Visible and WizardForm.NextButton.Enabled;
  Place(NextCaption, WizardForm.NextButton, NextPill.Left + (NextPill.Width + NextCaption.Width) div 2);
  NextCaption.Visible := NextPill.Visible;
  { Pill caption in its middle: placed again once its width is known. }
  NextCaption.Left := NextPill.Left + (NextPill.Width - NextCaption.Width) div 2;
  Place(CancelCaption, WizardForm.CancelButton, NextPill.Left - ScaleX(18));
  if CancelCaption.Visible then
    Place(BackCaption, WizardForm.BackButton, CancelCaption.Left - ScaleX(22))
  else
    Place(BackCaption, WizardForm.BackButton, NextPill.Left - ScaleX(18));
end;

{ An image of the art: carried in Setup, installed beside the app for the
  uninstaller, which has no archive to extract from. }
function Art(const Name: String): String;
begin
  if IsUninstaller then
  begin
    { A copy that outlives the uninstall, which deletes the originals. }
    Result := ExpandConstant('{tmp}\') + Name;
    if not FileExists(Result) then
      FileCopy(ExpandConstant('{app}\installer-art\') + Name, Result, False);
  end
  else
    Result := Png(Name);
end;

function Picture(Parent: TWinControl; const Name: String): TBitmapImage;
begin
  Result := TBitmapImage.Create(Parent);
  Result.Parent := Parent;
  Result.Stretch := True;
  Result.BackColor := clNone;
  Result.PngImage.LoadFromFile(Art(Name));
end;

{ The progress bar: a faint lane, the rainbow, and the rocket at its head,
  over the gauge they replace. }
procedure MakeProgress(Page: TWinControl; Gauge: TNewProgressBar);
var
  Middle: Integer;
begin
  Middle := Gauge.Top + Gauge.Height div 2;
  LaneLeft := Gauge.Left;
  LaneWidth := Gauge.Width;
  Track := Picture(Page, 'track.png');
  Track.SetBounds(Gauge.Left, Middle - ScaleY(6), Gauge.Width, ScaleY(12));
  Rainbow := Picture(Page, 'rainbow.png');
  Rainbow.SetBounds(Gauge.Left, Middle - ScaleY(6), 1, ScaleY(12));
  Rainbow.Visible := False;
  Rocket := Picture(Page, 'rocket.png');
  Rocket.Height := ScaleY(30);
  Rocket.Width := Rocket.Height * 308 div 72;
  Rocket.Top := Middle - Rocket.Height div 2;
  Rocket.Left := Gauge.Left;
  Gauge.Visible := False;
end;

procedure PlaceRocket(Done: Extended);
var
  Tail: Integer;
begin
  Rocket.Left := LaneLeft + Round((LaneWidth - Rocket.Width) * Done);
  { The rainbow comes out of the flame, a little under the rocket. }
  Tail := Rocket.Left + Rocket.Width div 10 - LaneLeft;
  Rainbow.Visible := Tail > 0;
  if Tail > 0 then
    Rainbow.Width := Tail;
end;

procedure ShowProgress(Gauge: TNewProgressBar);
begin
  Gauge.Visible := False;
  if Gauge.Max > Gauge.Min then
    PlaceRocket((Gauge.Position - Gauge.Min) / (Gauge.Max - Gauge.Min))
  else
    PlaceRocket(0);
end;

procedure InitializeWizard;
begin
  WizardForm.BorderStyle := bsNone;
  MakeButtons;
  MakeProgress(WizardForm.InstallingPage, WizardForm.ProgressGauge);
  HookDragging;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  SyncButtons;
  if CurPageID = wpInstalling then
    ShowProgress(WizardForm.ProgressGauge);
end;

procedure CurInstallProgressChanged(CurProgress, MaxProgress: Integer);
begin
  ShowProgress(WizardForm.ProgressGauge);
end;

procedure DeinitializeSetup;
begin
  UnhookDragging;
end;

{ The system's message boxes have a frame and its buttons: Setup's own
  questions go through this dialog instead. Frameless, the night sky, the
  main answer in a pill and the other as a plain word; Enter gives the main
  answer, Escape the other (or closes a single-answer dialog). }

const
  APP_NAME = '{#SetupSetting("AppName")}';

var
  DialogYes, DialogNo: TNewButton;

procedure DialogYesClick(Sender: TObject);
begin
  Press(DialogYes);
end;

procedure DialogNoClick(Sender: TObject);
begin
  Press(DialogNo);
end;

function Dialog(const Title, Text, Yes, No: String): Boolean;
var
  Form: TSetupForm;
  Back, Pill: TBitmapImage;
  Heading, Body, YesLabel, NoLabel: TNewStaticText;
begin
  Form := CreateCustomForm(ScaleX(440), ScaleY(180), False, True);
  try
    Form.BorderStyle := bsNone;
    Form.Caption := Title;
    Back := Picture(Form, 'back.png');
    Back.SetBounds(0, 0, Form.ClientWidth, Form.ClientHeight);
    Heading := TNewStaticText.Create(Form);
    Heading.Parent := Form;
    Heading.Caption := Title;
    Heading.Font.Size := 13;
    Heading.Font.Style := [fsBold];
    Heading.SetBounds(ScaleX(28), ScaleY(24), Form.ClientWidth - ScaleX(56), ScaleY(28));
    Body := TNewStaticText.Create(Form);
    Body.Parent := Form;
    Body.AutoSize := False;
    Body.WordWrap := True;
    Body.ShowAccelChar := False;
    Body.Font.Size := 10;
    Body.SetBounds(ScaleX(28), Heading.Top + Heading.Height + ScaleY(8), Form.ClientWidth - ScaleX(56), ScaleY(60));
    Body.Caption := Text;
    { The real buttons, out of sight, answer Enter and Escape. }
    DialogYes := TNewButton.Create(Form);
    DialogYes.Parent := Form;
    DialogYes.ModalResult := mrYes;
    DialogYes.Default := True;
    DialogYes.Top := -ScaleY(200);
    DialogNo := TNewButton.Create(Form);
    DialogNo.Parent := Form;
    DialogNo.ModalResult := mrNo;
    DialogNo.Cancel := True;
    DialogNo.Top := -ScaleY(200);
    Pill := Picture(Form, 'pill.png');
    Pill.Height := ScaleY(36);
    Pill.Width := Pill.Height * 288 div 80;
    Pill.Left := Form.ClientWidth - ScaleX(24) - Pill.Width;
    Pill.Top := Form.ClientHeight - ScaleY(22) - Pill.Height;
    Pill.Cursor := crHand;
    Pill.OnClick := @DialogYesClick;
    YesLabel := MakeLabel(Form, PILL_COLOR, @DialogYesClick);
    YesLabel.Caption := Yes;
    YesLabel.Left := Pill.Left + (Pill.Width - YesLabel.Width) div 2;
    YesLabel.Top := Pill.Top + (Pill.Height - YesLabel.Height) div 2;
    if No <> '' then
    begin
      NoLabel := MakeLabel(Form, GHOST_COLOR, @DialogNoClick);
      NoLabel.Caption := No;
      NoLabel.Left := Pill.Left - ScaleX(22) - NoLabel.Width;
      NoLabel.Top := Pill.Top + (Pill.Height - NoLabel.Height) div 2;
    end;
    Result := Form.ShowModal = mrYes;
  finally
    Form.Free;
  end;
end;

{ Leaving Setup midway asks in the same style. }
procedure CancelButtonClick(CurPageID: Integer; var Cancel, Confirm: Boolean);
begin
  Confirm := False;
  Cancel := Dialog(CustomMessage('AbortTitle'), FmtMessage(CustomMessage('AbortText'), [APP_NAME]),
    CustomMessage('AbortYes'), CustomMessage('AbortNo'));
end;

{ Inno Setup asks before uninstalling with a system message box, and says
  goodbye with another, unless the uninstaller runs /SILENT, which still
  shows the progress window (and the crash). So the question is ours, and
  a yes starts the uninstaller again, silent, marked to say goodbye. }
function InitializeUninstall: Boolean;
var
  Code: Integer;
begin
  Result := UninstallSilent;
  if Result then
    Exit;
  if Dialog(CustomMessage('ConfirmTitle'), FmtMessage(CustomMessage('ConfirmText'), [APP_NAME]),
    CustomMessage('ConfirmYes'), CustomMessage('ConfirmNo')) then
    Exec(ExpandConstant('{uninstallexe}'), '/SILENT /RVFAREWELL=1', '', SW_SHOW, ewNoWait, Code);
end;

procedure Farewell;
begin
  if ExpandConstant('{param:RVFAREWELL|0}') = '1' then
    Dialog(CustomMessage('Crashed'), FmtMessage(SetupMessage(msgUninstalledAll), [APP_NAME]),
      CustomMessage('FarewellYes'), '');
end;

{ The uninstaller: the same sky and rocket, which crashes. It all plays as
  the uninstall starts (usUninstall): by usPostUninstall Inno Setup has
  freed this window, and touching its controls then fails ("Could not call
  proc"). The rocket crosses its lane, dives and bursts, and the files go
  under the smoke, a moment more before the window closes. }

const
  { installer-art.py's CRASH_FRAMES and stage: 220x220, 60 left of and 20
    above the rocket at the lane's end. }
  CRASH_FRAMES = 32;
  FRAME_MS = 40;
  FLIGHT_STEPS = 30;

var
  CrashFrames: array of TBitmapImage;

procedure InitializeUninstallProgressForm;
var
  Form: TUninstallProgressForm;
  Gauge: TNewProgressBar;
  Back: TBitmapImage;
  I, Left, Top: Integer;
begin
  { The farewell's pill, copied before the uninstall deletes it. }
  Art('pill.png');
  Form := UninstallProgressForm;
  Form.BorderStyle := bsNone;
  Form.CancelButton.Visible := False;
  Back := Picture(Form, 'back.png');
  Back.SetBounds(0, 0, Form.ClientWidth, Form.ClientHeight);
  Back.SendToBack;
  Gauge := Form.ProgressBar;
  MakeProgress(Form.InstallingPage, Gauge);
  Left := Gauge.Left + Gauge.Width - Rocket.Width - ScaleX(60);
  Top := Rocket.Top - ScaleY(20);
  SetArrayLength(CrashFrames, CRASH_FRAMES);
  for I := 0 to CRASH_FRAMES - 1 do
  begin
    CrashFrames[I] := Picture(Form.InstallingPage, Format('crash-%.2d.png', [I]));
    CrashFrames[I].SetBounds(Left, Top, ScaleX(220), ScaleY(220));
    CrashFrames[I].Visible := False;
  end;
end;

procedure Crash;
var
  Page: TNewNotebookPage;
  I: Integer;
begin
  Page := UninstallProgressForm.InstallingPage;
  for I := 1 to FLIGHT_STEPS do
  begin
    PlaceRocket(I / FLIGHT_STEPS);
    Page.Update;
    Sleep(FRAME_MS);
  end;
  Rocket.Visible := False;
  UninstallProgressForm.StatusLabel.Caption := CustomMessage('Crashed');
  for I := 0 to CRASH_FRAMES - 1 do
  begin
    if I > 0 then
      CrashFrames[I - 1].Visible := False;
    CrashFrames[I].Visible := True;
    Page.Update;
    Sleep(FRAME_MS);
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if (CurUninstallStep = usUninstall) and (GetArrayLength(CrashFrames) > 0) then
    Crash;
  if CurUninstallStep = usPostUninstall then
    Farewell;
end;
