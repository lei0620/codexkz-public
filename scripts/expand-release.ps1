param(
  [Parameter(Mandatory)][string]$ArchivePath,
  [Parameter(Mandatory)][string]$Destination,
  [Parameter(Mandatory)][string]$Sha256
)
$ErrorActionPreference = 'Stop'
# The caller must first validate the signed release manifest and pass its hash.
function Write-NewFile([string]$Path, [string]$Text) {
  $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $bytes = [Text.Encoding]::UTF8.GetBytes($Text); $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) }
  finally { $stream.Dispose() }
}
if ($Sha256 -cnotmatch '^[0-9a-f]{64}$') { throw '无效的发行文件摘要' }
$archive = [IO.Path]::GetFullPath($ArchivePath)
$destination = [IO.Path]::GetFullPath($Destination)
if ($archive -match '^(?i:e:|\\\\)' -or $destination -match '^(?i:e:|\\\\)') { throw '未授权的磁盘或网络位置' }
if ([IO.File]::Exists($destination) -or [IO.Directory]::Exists($destination)) { throw '解包目标已存在，未覆盖' }
$parent = [IO.Path]::GetDirectoryName($destination)
if (-not [IO.Directory]::Exists($parent)) { throw '解包目标的父目录不存在' }
foreach ($start in @($archive, $parent)) {
  $current = $start
  while ($current) {
    if (([IO.File]::GetAttributes($current) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw '路径包含重定向' }
    $next = [IO.Path]::GetDirectoryName($current)
    if (-not $next -or $next -eq $current) { break }
    $current = $next
  }
}
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Sha256) { throw '发行文件摘要不匹配' }
Add-Type -AssemblyName System.IO.Compression
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CodexKzReleaseDirectory {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CreateDirectoryW(string path, IntPtr securityAttributes);
}
'@
$zip = [IO.Compression.ZipFile]::OpenRead($archive)
try {
  if ($zip.Entries.Count -gt 10000) { throw '发行文件过多' }
  $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $total = [long]0
  foreach ($entry in $zip.Entries) {
    $name = $entry.FullName
    if (-not $name -or $name.Contains('\') -or $name.StartsWith('/') -or $name -match '[\x00-\x1f<>:"|?*]') { throw '发行文件路径无效' }
    $isDirectory = $name.EndsWith('/')
    $parts = $name.TrimEnd('/').Split('/')
    if ($parts.Count -gt 64 -or $name.Length -gt 1024) { throw '发行文件路径过长' }
    foreach ($part in $parts) {
      if (-not $part -or $part -in @('.','..') -or $part.EndsWith('.') -or $part.EndsWith(' ') -or $part.Length -gt 255 -or $part -match '^(?i:con|conin\$|conout\$|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)') { throw '发行文件路径无效' }
    }
    $relative = [string]::Join('/', $parts)
    if ($relative -in @('.release-incomplete','.release-ready') -or -not $seen.Add($relative)) { throw '发行文件路径重复或保留' }
    $attributes = [uint32]([int64]$entry.ExternalAttributes -band [long]4294967295)
    $fileKind = ($attributes -shr 16) -band 0xf000
    if (($fileKind -ne 0 -and $fileKind -notin @(0x8000,0x4000)) -or ($attributes -band 0x400) -ne 0) { throw '发行文件包含链接或非常规条目' }
    if (($fileKind -eq 0x4000 -and -not $isDirectory) -or ($fileKind -eq 0x8000 -and $isDirectory)) { throw '发行文件类型与路径不一致' }
    if ($isDirectory -and $entry.Length -ne 0) { throw '发行目录包含数据' }
    if ($entry.Length -gt 536870912) { throw '发行文件过大' }
    $total += $entry.Length
    if ($total -gt 1073741824) { throw '发行内容过大' }
  }
  if (-not [CodexKzReleaseDirectory]::CreateDirectoryW($destination, [IntPtr]::Zero)) { throw '解包目录无法安全创建或已存在' }
  $incomplete = Join-Path $destination '.release-incomplete'
  Write-NewFile $incomplete 'incomplete'
  $buffer = [byte[]]::new(1048576)
  foreach ($entry in $zip.Entries) {
    $parts = $entry.FullName.TrimEnd('/').Split('/')
    $target = $destination
    foreach ($part in $parts) { $target = Join-Path $target $part }
    if ($entry.FullName.EndsWith('/')) { [IO.Directory]::CreateDirectory($target) | Out-Null; continue }
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
    $inputStream = $entry.Open(); $outputStream = $null
    try {
      $outputStream = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
      $written = [long]0
      while (($count = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
        $written += $count
        if ($written -gt $entry.Length) { throw '发行文件解压大小不符' }
        $outputStream.Write($buffer, 0, $count)
      }
      if ($written -ne $entry.Length) { throw '发行文件解压大小不符' }
      $outputStream.Flush($true)
    } finally { if ($outputStream) { $outputStream.Dispose() }; $inputStream.Dispose() }
  }
  if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Sha256) { throw '发行文件在解包期间发生变化' }
  [IO.File]::Delete($incomplete)
  Write-NewFile (Join-Path $destination '.release-ready') $Sha256
  Write-Output '解包完成，仍需由更新器重新核验后切换。'
} finally { $zip.Dispose() }
