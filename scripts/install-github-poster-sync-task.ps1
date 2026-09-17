$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$scriptPath = Join-Path $projectRoot "scripts\publish-github-posters.ps1"
$taskName = "Komo-GameNews-GitHub-PosterSync"
$user = "$env:USERDOMAIN\$env:USERNAME"
$powershell = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"

$action = New-ScheduledTaskAction -Execute $powershell -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`""
$trigger = New-ScheduledTaskTrigger -Daily -At 9:00AM
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 20)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description "GameNews：每日同步日报/周报归档至私有 GitHub 仓库。" -User $user -RunLevel Limited -Force | Out-Null
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State
