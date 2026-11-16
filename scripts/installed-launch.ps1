param(
  [Parameter(Mandatory)][string]$DataRoot,
  [ValidateRange(1024,65535)][int]$Port = 4319
)
$ErrorActionPreference = 'Stop'
$bootstrapProgram = Split-Path -Parent $PSScriptRoot
$install = Split-Path -Parent $bootstrapProgram
$bootstrapNode = Join-Path $install 'runtime/node/node.exe'
$bootstrapShell = Join-Path $install 'runtime/powershell/pwsh.exe'
$ready = Join-Path $DataRoot '.installed-data-ready'
if (-not [IO.Path]::IsPathFullyQualified($DataRoot) -or $DataRoot -match '^(?i:e:|\\\\)') { throw '数据目录必须是获准的本机绝对路径。' }
if (-not [IO.File]::Exists($bootstrapNode) -or -not [IO.File]::Exists($bootstrapShell)) { throw '随包运行时缺失，请重新安装程序。' }
if (-not [IO.File]::Exists($ready) -or [IO.File]::ReadAllText($ready) -cne "codexkz-installed-data-v1`n") { throw '数据目录未初始化完成，请保留数据并核对。' }
$listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
if ($listener) { throw "端口 $Port 已被占用；未停止或更改现有服务。" }
& $bootstrapNode (Join-Path $bootstrapProgram 'scripts/check-installed.mjs') $bootstrapProgram
if ($LASTEXITCODE -ne 0) { throw '安装文件检查未通过，未启动程序。' }
$resolution = & $bootstrapNode (Join-Path $bootstrapProgram 'scripts/resolve-installed-version.mjs') $install $DataRoot
if ($LASTEXITCODE -ne 0) { throw '未能安全选择版本；请核对未完成升级并使用恢复入口。' }
$selected = $resolution | ConvertFrom-Json
$program = $selected.program; $node = $selected.node; $shell = $selected.pwsh
if (-not [IO.File]::Exists($node) -or -not [IO.File]::Exists($shell) -or -not [IO.Directory]::Exists($program)) { throw '当前版本运行时缺失。' }
$env:PATH = (Split-Path -Parent $shell) + [IO.Path]::PathSeparator + $env:PATH
$env:CODEXKZ_INSTALLED_DATA_ROOT = [IO.Path]::GetFullPath($DataRoot)
$env:CODEXKZ_INSTALL_ROOT = $install
$env:PORT = [string]$Port
& $node (Join-Path $program 'panel-runner.mjs')
exit $LASTEXITCODE
