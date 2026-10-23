$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$scriptPath = Join-Path $projectRoot "scripts\publish-github-posters.ps1"
$taskName = "Komo-GameNews-GitHub-PosterSync"
$user = "$env:USERDOMAIN\$env:USERNAME"
$launcher = Join-Path $PSScriptRoot "run-github-poster-sync.vbs"

$action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\wscript.exe" -Argument "`"$launcher`" `"$scriptPath`"" -WorkingDirectory $projectRoot
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
  Set-ScheduledTask -TaskName $taskName -Action $action -Description "GameNews: daily GitHub poster archive; exit code and upload result verified." | Out-Null
  Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State
  exit 0
}
$trigger = New-ScheduledTaskTrigger -Daily -At 9:00AM
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 20)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description "GameNews: daily GitHub poster archive; exit code and upload result verified." -User $user -RunLevel Limited -Force | Out-Null
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State
