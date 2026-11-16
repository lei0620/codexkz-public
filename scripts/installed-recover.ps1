param([Parameter(Mandatory)][string]$DataRoot)
$ErrorActionPreference = 'Stop'
$program = Split-Path -Parent $PSScriptRoot
$install = Split-Path -Parent $program
$node = Join-Path $install 'runtime/node/node.exe'
if (-not [IO.Path]::IsPathFullyQualified($DataRoot) -or $DataRoot -match '^(?i:e:|\\\\)') { throw '数据目录必须是获准的本机绝对路径。' }
if (-not [IO.File]::Exists($node)) { throw '初始运行时缺失，请保留数据并核对安装。' }
& $node (Join-Path $program 'scripts/check-installed.mjs') $program
if ($LASTEXITCODE -ne 0) { throw '初始安装文件检查未通过，未修改版本或数据。' }
& $node (Join-Path $program 'scripts/recover-installed-update.mjs') $install $DataRoot
if ($LASTEXITCODE -ne 0) { throw '无法安全恢复旧程序；当前数据和备份均已保留，请人工核对。' }
