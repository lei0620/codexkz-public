$ErrorActionPreference = 'Stop'
try {
  $packages = @(Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction Stop)
  if ($packages.Count -gt 0) { exit 0 }
  exit 1
} catch {
  # An unavailable package API is unknown, not proof that Codex is absent.
  exit 2
}
