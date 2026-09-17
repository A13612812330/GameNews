$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$watchdog = Join-Path $projectRoot "scripts\gamenews-watchdog.ps1"
$existing = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$watchdog*" } |
  Select-Object -First 1
if (-not $existing) {
  Start-Process powershell.exe -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $watchdog) -WorkingDirectory $projectRoot -WindowStyle Hidden | Out-Null
}
Write-Output "GameNews 守护服务已启动或已在运行"
