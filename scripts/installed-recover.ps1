param([Parameter(Mandatory)][string]$DataRoot)
$ErrorActionPreference = 'Stop'
$program = Split-Path -Parent $PSScriptRoot
$install = Split-Path -Parent $program
$node = Join-Path $install 'runtime/node/node.exe'
if (-not [IO.File]::Exists($node)) { throw '初始运行时缺失，请保留数据并核对安装。' }
$DataRoot = & $node (Join-Path $PSScriptRoot 'installed-plugin.mjs') location $DataRoot
if ($LASTEXITCODE -ne 0 -or -not $DataRoot) { throw '无法读取派板的数据位置，请检查安装目录。' }
& $node (Join-Path $program 'scripts/check-installed.mjs') $program
if ($LASTEXITCODE -ne 0) { throw '初始安装文件检查未通过，未修改版本或数据。' }
& $node (Join-Path $program 'scripts/recover-installed-update.mjs') $install $DataRoot
if ($LASTEXITCODE -ne 0) { throw '无法安全恢复旧程序；当前数据和备份均已保留，请人工核对。' }
