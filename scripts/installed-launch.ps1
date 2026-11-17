param(
  [Parameter(Mandatory)][string]$DataRoot,
  [ValidateRange(0,65535)][int]$Port = 0,
  [switch]$OpenBrowser,
  [switch]$ConnectCodex
)
$ErrorActionPreference = 'Stop'
$bootstrapProgram = Split-Path -Parent $PSScriptRoot
$install = Split-Path -Parent $bootstrapProgram
$bootstrapNode = Join-Path $install 'runtime/node/node.exe'
$bootstrapShell = Join-Path $install 'runtime/powershell/pwsh.exe'
$mutex = $null
$ownsMutex = $false
$openPage = $null

function Show-Message([string]$Text, [bool]$IsError = $false) {
  $shell = New-Object -ComObject WScript.Shell
  $icon = if ($IsError) { 16 } else { 64 }
  $null = $shell.Popup($Text, 0, '派板', $icon)
}

function Open-ExistingPanel([string]$Origin, [string]$LaunchId, [int]$Seconds) {
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  do {
    try {
      $service = Invoke-RestMethod "$Origin/api/service/health" -MaximumRedirection 0 -TimeoutSec 2
      if ($service.launchId -cne $LaunchId) { return $false }
      Start-Process "$Origin/"
      return $true
    } catch {}
    Start-Sleep -Milliseconds 300
  } while ([DateTime]::UtcNow -lt $deadline)
  return $false
}

try {
  if (-not [IO.Path]::IsPathFullyQualified($DataRoot) -or $DataRoot -match '^(?i:e:|\\\\)') { throw '数据目录必须是本机绝对路径。' }
  $ready = Join-Path $DataRoot '.installed-data-ready'
  if (-not [IO.File]::Exists($ready) -or [IO.File]::ReadAllText($ready) -cne "codexkz-installed-data-v1`n") { throw '数据目录初始化尚未完成。请核对安装进度和数据目录。' }
  if (-not [IO.File]::Exists($bootstrapNode) -or -not [IO.File]::Exists($bootstrapShell)) { throw '派板的运行组件缺失，请核对安装文件。' }
  if ($ConnectCodex) {
    $result = & $bootstrapNode (Join-Path $PSScriptRoot 'installed-plugin.mjs') register $DataRoot 2>&1
    if ($LASTEXITCODE -ne 0) {
      $detail = ($result | ForEach-Object { [string]$_ } | Where-Object { $_ -match '^Error: .+' } | Select-Object -First 1) -replace '^Error: ', ''
      throw $(if($detail){$detail}else{'未能接入 Codex 白板，请确认 Codex 桌面应用可用。'})
    }
    Show-Message '白板已接入 Codex。完成当前工作后重新打开 Codex，再使用「派板 · 本聊天白板」。'
    exit 0
  }

  $launchId = ''
  $launchFile = Join-Path $install 'paiban-launch.json'
  if ([IO.File]::Exists($launchFile)) {
    $settings = Get-Content -LiteralPath $launchFile -Raw | ConvertFrom-Json
    if ($settings.version -ne 1 -or $settings.id -cnotmatch '^[a-f0-9]{32}$' -or $settings.port -lt 1024 -or $settings.port -gt 65535) { throw '派板启动设置无效，请核对安装目录。' }
    $launchId = $settings.id
    if ($Port -eq 0) { $Port = $settings.port }
  }
  if ($Port -eq 0) { $Port = 4319 }
  if ($Port -lt 1024) { throw '派板启动端口无效。' }
  $origin = "http://127.0.0.1:$Port"
  if ($launchId) {
    $mutex = [Threading.Mutex]::new($false, "Local\Paiban-$launchId")
    try { $ownsMutex = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (-not $ownsMutex) {
      if ($OpenBrowser -and (Open-ExistingPanel $origin $launchId 40)) { exit 0 }
      throw '派板正在启动或运行。请稍等后从开始菜单重新打开。'
    }
  }
  if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) {
    if ($OpenBrowser -and $launchId -and (Open-ExistingPanel $origin $launchId 2)) { exit 0 }
    throw "派板的端口 $Port 正被其他程序使用。请核对当前打开的程序后重试。"
  }
  & $bootstrapNode (Join-Path $PSScriptRoot 'check-installed.mjs') $bootstrapProgram
  if ($LASTEXITCODE -ne 0) { throw '派板安装文件检查未通过。' }
  $resolution = & $bootstrapNode (Join-Path $PSScriptRoot 'resolve-installed-version.mjs') $install $DataRoot
  if ($LASTEXITCODE -ne 0) { throw '请从派板安装目录打开「恢复未完成升级」，核对当前版本。' }
  $selected = $resolution | ConvertFrom-Json
  $program = $selected.program; $node = $selected.node; $shell = $selected.pwsh
  if (-not [IO.File]::Exists($node) -or -not [IO.File]::Exists($shell) -or -not [IO.Directory]::Exists($program)) { throw '当前版本的派板运行组件缺失。' }
  $env:PATH = (Split-Path -Parent $shell) + [IO.Path]::PathSeparator + $env:PATH
  $env:CODEXKZ_INSTALLED_DATA_ROOT = [IO.Path]::GetFullPath($DataRoot)
  $env:CODEXKZ_INSTALL_ROOT = $install
  $env:PAIBAN_LAUNCH_ID = $launchId
  $env:PORT = [string]$Port
  if ($OpenBrowser) {
    $openPage = Start-ThreadJob -ArgumentList $origin, $selected.version, $launchId -ScriptBlock {
      param($PanelOrigin, $PanelVersion, $LaunchId)
      $deadline = [DateTime]::UtcNow.AddSeconds(40)
      do {
        try { $service = Invoke-RestMethod "$PanelOrigin/api/service/health" -MaximumRedirection 0 -TimeoutSec 2 } catch { $service = $null }
        if ($service.instanceId -and $service.productVersion -eq $PanelVersion -and (!$LaunchId -or $service.launchId -ceq $LaunchId)) {
          Start-Process "$PanelOrigin/"
          return
        }
        Start-Sleep -Milliseconds 400
      } while ([DateTime]::UtcNow -lt $deadline)
    }
  }
  & $node (Join-Path $program 'panel-runner.mjs')
  if ($LASTEXITCODE -ne 0) { throw '派板服务未能正常启动，请检查安装目录和数据位置。' }
} catch {
  if ($OpenBrowser -or $ConnectCodex) { Show-Message $_.Exception.Message $true } else { Write-Error -ErrorAction Continue $_ }
  exit 1
} finally {
  if ($openPage) { Remove-Job -Job $openPage -Force }
  if ($ownsMutex) { $mutex.ReleaseMutex() }
  if ($mutex) { $mutex.Dispose() }
}
exit 0
