$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$watchdog = Join-Path $projectRoot "scripts\gamenews-watchdog.ps1"
$taskName = "Komo-GameNews-Watchdog"
$powershell = Join-Path $PSHOME "powershell.exe"
if (-not (Test-Path $powershell)) { $powershell = "powershell.exe" }

# 2026-09-28 fix: the previous version registered this task with
# /SC ONLOGON, i.e. it fired exactly once per logon. The watchdog is a
# resident loop (while($true) in gamenews-watchdog.ps1), so once it was
# killed the 64424 / 64425 services lost their supervisor permanently --
# measured: last run 09-21 14:25, exit code 3221225786
# (STATUS_CONTROL_C_EXIT), nothing restarted it afterwards.
#
# Now: logon trigger + every 5 minutes, indefinitely. Because the watchdog
# stays resident, each repeat hit is skipped by the scheduler
# (MultipleInstances = IgnoreNew), so no duplicate supervisors appear;
# if it does die, it is back within 5 minutes.
#
# Also sets ExecutionTimeLimit to zero (= unlimited). The default is 72h,
# which would silently kill a resident supervisor every three days.
#
# Uses the ScheduledTasks cmdlets instead of schtasks.exe so it runs
# without shelling out to a legacy binary.

$action = New-ScheduledTaskAction -Execute $powershell `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$watchdog`""

$trigger = New-ScheduledTaskTrigger -AtLogOn
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 5) `
    -RepetitionDuration (New-TimeSpan -Days 3650)).Repetition

$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Settings $settings -Force | Out-Null

Start-ScheduledTask -TaskName $taskName

Write-Output "rebuilt and started $taskName (logon + self-heal every 5 min, no execution time limit)"
