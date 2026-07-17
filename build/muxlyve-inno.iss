; Muxlyve — Instalador Inno Setup
; Compilar: ISCC.exe build\muxlyve-inno.iss

#define MyAppName "Muxlyve"
#define MyAppVersion "0.3.2"
#define MyAppPublisher "BLACKRAKEN SOLUTIONS"
#define MyAppURL "https://muxlyve.app"
#define MyAppExeName "Muxlyve.exe"

[Setup]
AppId={{B8A7E3F0-4D5C-4F2A-9E1C-8D6F7A2B3C4D}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=..\dist-app
OutputBaseFilename=Muxlyve Setup {#MyAppVersion} Inno
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
UninstallDisplayIcon={app}\{#MyAppExeName}

; Branding — reusa los assets de build/
WizardImageFile=..\build\installer-sidebar.bmp
WizardSmallImageFile=..\build\wizard-small.bmp
SetupIconFile=..\build\icon-muxlyve.ico
UninstallDisplayName={#MyAppName}

[Languages]
Name: "spanish"; MessagesFile: "compiler:Languages\Spanish.isl"

[Tasks]
Name: "desktopicon"; Description: "Crear acceso directo en el escritorio"; GroupDescription: "Accesos directos:"; Flags: checkedonce
Name: "startup"; Description: "Iniciar {#MyAppName} al encender el equipo"; GroupDescription: "Opciones adicionales:"

[Files]
Source: "..\dist-app\win-unpacked\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{commondesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Abrir {#MyAppName}"; Flags: postinstall nowait skipifsilent shellexec

[UninstallRun]
Filename: "{cmd}"; Parameters: "/c taskkill /im ""{#MyAppExeName}"" /f /t"; Flags: runhidden

[Code]
var
  OptionPage: TInputOptionWizardPage;
  AutoStart: Boolean;

procedure InitializeWizard;
begin
  WizardForm.WelcomeLabel1.Font.Color := $5C5CFF;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
begin
  if CurStep = ssPostInstall then
  begin
    if WizardIsTaskSelected('startup') then
    begin
      ShellExec('', 'reg', 'add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "Muxlyve" /d "' + ExpandConstant('{app}') + '\{#MyAppExeName}' + '" /f', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    end;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  ResultCode: Integer;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    ShellExec('', 'reg', 'delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "Muxlyve" /f', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;
end;

[CustomMessages]
spanish.WelcomeLabel1=Este asistente instalarás {#MyAppName} en tu equipo.
spanish.WelcomeLabel2=Muxlyve te permite transmitir en simultáneo a Twitch, Kick, YouTube y TikTok desde tu propia PC — sin marca de agua.
