$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$watchdog = Join-Path $projectRoot "scripts\gamenews-watchdog.ps1"
$taskName = "Komo-GameNews-Watchdog"
$powershell = Join-Path $PSHOME "powershell.exe"
if (-not (Test-Path $powershell)) { $powershell = "powershell.exe" }

# 仅在当前用户登录后启动；不需要管理员权限，也不会在未登录时运行。
$taskAction = "`"$powershell`" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$watchdog`""
& schtasks.exe /Create /TN $taskName /SC ONLOGON /RL LIMITED /TR $taskAction /F | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "无法创建登录自启任务。请以管理员身份运行此脚本，或继续使用 npm run start 手动启动。"
}
& schtasks.exe /Run /TN $taskName | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "任务已创建，但无法立即启动。请在任务计划程序中手动运行：$taskName"
}
Write-Output "已创建并启动 $taskName"
