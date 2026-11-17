#ifndef PayloadDir
  #error PayloadDir is required
#endif
#ifndef OutputDir
  #error OutputDir is required
#endif
#ifndef ProductVersion
  #error ProductVersion is required
#endif

[Setup]
#ifdef IsolatedTest
AppId={{6F26C4FC-1847-44E2-B8F1-E49B19D9D40B}
Uninstallable=no
#else
AppId={{37C3F9AB-6301-4C31-83EA-28E530D93995}
Uninstallable=yes
#endif
AppName=派板 (Paiban)
AppVersion={#ProductVersion}
DefaultDirName={localappdata}\Programs\CodexKZ
UsePreviousAppDir=no
DefaultGroupName=派板
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=no
RestartApplications=no
OutputDir={#OutputDir}
#ifdef IsolatedTest
OutputBaseFilename=CodexKZ-{#ProductVersion}-test-only
Compression=zip
SolidCompression=no
#else
OutputBaseFilename=Paiban-Setup-v{#ProductVersion}-win-x64
Compression=lzma2
SolidCompression=yes
#endif
WizardStyle=modern

[Files]
Source: "{#PayloadDir}\program\*"; DestDir: "{app}\program"; Flags: ignoreversion onlyifdoesntexist recursesubdirs createallsubdirs
Source: "{#PayloadDir}\runtime\*"; DestDir: "{app}\runtime"; Flags: ignoreversion onlyifdoesntexist recursesubdirs createallsubdirs

[Languages]
Name: "chinesesimp"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Icons]
Name: "{app}\启动本机面板"; Filename: "{app}\runtime\powershell\pwsh.exe"; Parameters: "{code:LauncherArguments}"; WorkingDir: "{app}\program"
Name: "{app}\恢复未完成升级"; Filename: "{app}\runtime\powershell\pwsh.exe"; Parameters: "{code:RecoveryArguments}"; WorkingDir: "{app}\program"
#ifndef IsolatedTest
Name: "{group}\派板"; Filename: "{app}\runtime\powershell\pwsh.exe"; Parameters: "{code:LauncherArguments}"; WorkingDir: "{app}\program"

[Run]
Filename: "{app}\runtime\powershell\pwsh.exe"; Parameters: "{code:LauncherArguments}"; WorkingDir: "{app}\program"; Description: "启动派板"; Flags: postinstall skipifsilent nowait
#endif

[Messages]
WelcomeLabel2=派板需要已安装并运行的 Codex 桌面应用。%n%n请先关闭其他安装程序。现有运行任务不会被强制结束。

[Code]
var
  PathsPage: TInputDirWizardPage;
  SourcePage: TInputDirWizardPage;
  ModePage: TInputOptionWizardPage;
  ConnectPage: TOutputMsgMemoWizardPage;

function CreateDirectoryExclusive(Path: String; SecurityAttributes: LongWord): Boolean;
  external 'CreateDirectoryW@kernel32.dll stdcall';

function LauncherArguments(Param: String): String;
begin
  Result := '-NoProfile -File ' + AddQuotes(ExpandConstant('{app}\program\scripts\installed-launch.ps1')) + ' -DataRoot ' + AddQuotes(PathsPage.Values[0]) + ' -OpenBrowser';
end;

function RecoveryArguments(Param: String): String;
begin
  Result := '-NoProfile -NoExit -File ' + AddQuotes(ExpandConstant('{app}\program\scripts\installed-recover.ps1')) + ' -DataRoot ' + AddQuotes(PathsPage.Values[0]);
end;

function SafeAbsoluteDirectory(Value: String): Boolean;
begin
  Result := False;
  if Length(Value) < 4 then exit;
  Result := (Value[2] = ':') and
    ((Value[3] = '\') or (Value[3] = '/')) and
    (Uppercase(Copy(Value, 1, 2)) <> 'E:') and
    (Pos('"', Value) = 0);
end;

function NoRedirectedPath(Value: String): Boolean;
var Current, Parent: String; Item: TFindRec;
begin
  Result := False;
  Current := ExpandFileName(Value);
  while Length(Current) > 3 do begin
    if FindFirst(Current, Item) then begin
      try
        if (Item.Attributes and FILE_ATTRIBUTE_REPARSE_POINT) <> 0 then exit;
      finally
        FindClose(Item);
      end;
    end;
    Parent := ExtractFileDir(Current);
    if (Parent = '') or (Parent = Current) then exit;
    Current := Parent;
  end;
  Result := True;
end;

function PathsOverlap(Left, Right: String): Boolean;
var L, R: String;
begin
  L := Uppercase(AddBackslash(ExpandFileName(Left)));
  R := Uppercase(AddBackslash(ExpandFileName(Right)));
  Result := (Copy(L, 1, Length(R)) = R) or (Copy(R, 1, Length(L)) = L);
end;

procedure InitializeWizard;
var DataArg, BackupArg, SourceArg: String;
begin
  SourceArg := ExpandConstant('{param:SourceRoot|}');
  ModePage := CreateInputOptionPage(wpSelectDir, '选择安装方式',
    '请选择全新安装或迁移旧数据', '迁移前请正常停止旧面板；原源码与数据不会覆盖。', True, False);
  ModePage.Add('全新安装');
  ModePage.Add('迁移旧源码项目数据');
  ModePage.Values[0] := SourceArg = '';
  ModePage.Values[1] := SourceArg <> '';
  PathsPage := CreateInputDirPage(ModePage.ID, '数据和备份位置',
    '程序文件与数据分开保存',
    '请选择新的数据目录和本机备份目录。', False, '');
  PathsPage.Add('新的数据目录：');
  PathsPage.Add('本机备份目录：');
  SourcePage := CreateInputDirPage(PathsPage.ID, '旧源码项目目录',
    '请选择原项目目录', '仅在旧面板停止并且没有未决操作时迁移。', False, '');
  SourcePage.Add('旧源码项目目录：');
  ConnectPage := CreateOutputMsgMemoPage(SourcePage.ID, '接入本聊天白板',
    '安装完成后，将面板连接到 Codex 桌面应用', '请保存以下步骤；安装程序不会更改已有插件配置。', '');
  DataArg := ExpandConstant('{param:DataRoot|}');
  BackupArg := ExpandConstant('{param:BackupRoot|}');
  if DataArg = '' then DataArg := ExpandConstant('{localappdata}\CodexKZData');
  if BackupArg = '' then BackupArg := ExpandConstant('{localappdata}\PaibanBackups');
  PathsPage.Values[0] := DataArg;
  PathsPage.Values[1] := BackupArg;
  SourcePage.Values[0] := SourceArg;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = ConnectPage.ID then
    ConnectPage.RichEditViewer.Lines.Text :=
      '安装后可从开始菜单启动派板，面板会在浏览器打开。点击“开始设置”按步骤配置，每一步均可复制 Codex 指令。' + #13#10 + #13#10 +
      '如需在 Codex 聊天里打开白板，先启动派板，再在 PowerShell 中运行：' + #13#10 +
      'codex plugin marketplace add ' + AddQuotes(ExpandConstant('{app}\codex-plugin')) + ' --json' + #13#10 +
      'codex plugin add paiban-board@paiban-local --json' + #13#10 + #13#10 +
      '在 Codex 中重新加载插件连接并打开“派板 · 本聊天白板”。插件连接启动时读取派板的当前版本。' + #13#10 + #13#10 +
      '如果本机已有 paiban-local 插件市场，先核对它的来源。旧的本机面板与派板使用相同的默认端口，需要先正常退出旧面板。';
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := (PageID = SourcePage.ID) and ModePage.Values[0];
end;

function PathProblem(CheckSource: Boolean): String;
var AppPath, DataPath, BackupPath, SourcePath: String;
begin
  Result := '';
  AppPath := ExpandConstant('{app}');
  DataPath := PathsPage.Values[0];
  BackupPath := PathsPage.Values[1];
  SourcePath := SourcePage.Values[0];
  if not SafeAbsoluteDirectory(AppPath) or not SafeAbsoluteDirectory(DataPath) or not SafeAbsoluteDirectory(BackupPath) then
    Result := '请填写获准的本机绝对路径；不使用网络路径或 E 盘。'
  else if not NoRedirectedPath(AppPath) or not NoRedirectedPath(DataPath) or not NoRedirectedPath(BackupPath) then
    Result := '目录包含重定向，未安装。'
  else if PathsOverlap(AppPath, DataPath) or PathsOverlap(DataPath, BackupPath) or PathsOverlap(AppPath, BackupPath) then
    Result := '程序、数据和备份目录必须彼此独立。'
  else if CheckSource and ModePage.Values[1] and not SafeAbsoluteDirectory(SourcePath) then
    Result := '旧源码目录必须是获准的本机绝对路径。'
  else if CheckSource and ModePage.Values[1] and not NoRedirectedPath(SourcePath) then
    Result := '旧源码目录包含重定向，未迁移。'
  else if CheckSource and ModePage.Values[1] and (not DirExists(SourcePath) or not DirExists(AddBackslash(SourcePath) + 'data')) then
    Result := '旧源码目录或其 data 目录不存在。'
  else if CheckSource and ModePage.Values[1] and (PathsOverlap(SourcePath, AppPath) or PathsOverlap(SourcePath, DataPath) or PathsOverlap(SourcePath, BackupPath)) then
    Result := '旧源码、程序、数据和备份目录必须彼此独立。'
  else if DirExists(AppPath) or FileExists(AppPath) then
    Result := '程序目录已存在，为保护已有文件，本安装器不会覆盖。'
  else if DirExists(DataPath) or FileExists(DataPath) then
    Result := '数据目录已存在，为保护已有数据，本安装器不会覆盖。'
  else if FileExists(BackupPath) then
    Result := '备份目录不能是文件。'
  else if not DirExists(ExtractFileDir(AppPath)) then
    Result := '程序目录的父目录不存在，请选择已有父目录下的新目录。'
  else if not DirExists(ExtractFileDir(DataPath)) then
    Result := '数据目录的父目录不存在，请选择已有父目录下的新目录。';
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var Problem: String;
begin
  Result := True;
  if (CurPageID = PathsPage.ID) or (CurPageID = SourcePage.ID) then begin
    Problem := PathProblem(CurPageID = SourcePage.ID);
    if Problem <> '' then begin MsgBox(Problem, mbError, MB_OK); Result := False; end;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := PathProblem(True);
  if (Result = '') and not CreateDirectoryExclusive(ExpandConstant('{app}'), 0) then
    Result := '程序目录无法独占创建或已被占用，未覆盖任何文件。';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var ExitCode: Integer; Arguments, BackupTarget: String; Detected: Boolean;
begin
  if CurStep = ssPostInstall then begin
    Arguments := AddQuotes(ExpandConstant('{app}\program\scripts\check-installed.mjs')) + ' ' + AddQuotes(ExpandConstant('{app}\program'));
    if not Exec(ExpandConstant('{app}\runtime\node\node.exe'), Arguments, ExpandConstant('{app}\program'), SW_HIDE, ewWaitUntilTerminated, ExitCode) or (ExitCode <> 0) then
      RaiseException('安装文件检查失败，未初始化或覆盖数据。');
    if ModePage.Values[0] then begin
      Arguments := AddQuotes(ExpandConstant('{app}\program\scripts\initialize-installed-data.mjs')) + ' ' +
        AddQuotes(ExpandConstant('{app}\program')) + ' ' + AddQuotes(PathsPage.Values[0]) + ' ' + AddQuotes(PathsPage.Values[1]);
      if not Exec(ExpandConstant('{app}\runtime\node\node.exe'), Arguments, ExpandConstant('{app}\program'), SW_HIDE, ewWaitUntilTerminated, ExitCode) or (ExitCode <> 0) then
        RaiseException('数据初始化失败；已有数据未覆盖。请保留未完成目录并检查备份位置。');
    end else begin
      if not ForceDirectories(PathsPage.Values[1]) or not NoRedirectedPath(PathsPage.Values[1]) then
        RaiseException('备份目录不可用或被重定向，未迁移原数据。');
      BackupTarget := AddBackslash(PathsPage.Values[1]) + GetDateTimeString('yyyy-mm-dd_hhnn', '-', '-') + '_数据迁移_' + GetDateTimeString('sszzz', '-', '-');
      Arguments := AddQuotes(ExpandConstant('{app}\program\scripts\migrate-installed-data.mjs')) + ' ' +
        AddQuotes(SourcePage.Values[0]) + ' ' + AddQuotes(PathsPage.Values[0]) + ' ' + AddQuotes(BackupTarget) + ' ' + AddQuotes(PathsPage.Values[1]);
      if not Exec(ExpandConstant('{app}\runtime\node\node.exe'), Arguments, ExpandConstant('{app}\program'), SW_HIDE, ewWaitUntilTerminated, ExitCode) or (ExitCode <> 0) then
        RaiseException('迁移未完成；请检查旧面板是否已正常停止并核对备份。原目录未覆盖。');
    end;
    Arguments := AddQuotes(ExpandConstant('{app}\program\scripts\installed-plugin.mjs')) + ' create';
    if not Exec(ExpandConstant('{app}\runtime\node\node.exe'), Arguments, ExpandConstant('{app}\program'), SW_HIDE, ewWaitUntilTerminated, ExitCode) or (ExitCode <> 0) then
      RaiseException('创建 Codex 插件接入文件失败。请保留已初始化的数据目录。');
    Arguments := '-NoProfile -NonInteractive -File ' + AddQuotes(ExpandConstant('{app}\program\scripts\check-codex-desktop.ps1'));
    Detected := Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), Arguments, '', SW_HIDE, ewWaitUntilTerminated, ExitCode);
    if not Detected or (ExitCode <> 0) then
      MsgBox('未能确认已安装 Codex 桌面应用。请自行安装并运行 Codex 后，再接入本聊天白板。', mbInformation, MB_OK);
  end;
end;
