$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$watchdog = Join-Path $projectRoot "scripts\gamenews-watchdog.ps1"
$taskName = "Komo-GameNews-Watchdog"
$powershell = Join-Path $PSHOME "powershell.exe"
if (-not (Test-Path $powershell)) { $powershell = "powershell.exe" }

# 2026-09-28 的三层修正（每一层都实测踩过，别回退）：
#
# 第 1 层：最早的任务是 /SC ONLOGON —— 只在登录时跑一次。守护本身是常驻循环，
# 被杀后再没人重启（实测最后运行 09-21 14:25，结果码 3221225786
# = STATUS_CONTROL_C_EXIT，之后长期无人守护）。
# 修法：给触发器加「每 N 分钟重复」，让任务负责反复拉起。
#
# 第 2 层：加了重复触发后仍不行 —— 任务动作直接写
# powershell.exe -File watchdog.ps1 时，任务实例与那个 PowerShell 绑定，
# 实测会以 0xC000013A 提前结束，守护随之消失（日志只留一行 start）。
# 修法：不再依赖常驻。脚本默认行为改成「一次健康检查后退出」，
# 由任务每分钟调用一次。进程短命、正常退出，彻底绕开这一类问题。
#
# 第 3 层（关键）：**登录触发器上挂 Repetition 不会按预期反复触发**。
# `<LogonTrigger><Repetition>` 要等登录事件真的发生才会计时；重新注册任务
# 不会补一次登录 ⇒ `NextRunTime` 为空、任务实际停摆（实测 16:27 之后再没跑过）。
# 修法（当前方案）：改用**时间触发器**（每天 00:00 起）+ 每 1 分钟重复、
# 持续 3650 天、`StopAtDurationEnd=false`（否则到期会停任务）。
# 换完 `Get-ScheduledTaskInfo` 的 `NextRunTime` 立即有值。
#
# 任务动作**不带参数**（脚本无参数即一次性检查）；常驻模式改用 -Resident
# 显式开启，只在需要本机盯着看的时候用。
#
# 权限与踩坑提示：
# - 实测 `Set-ScheduledTask -TaskName X -Trigger $t` 普通权限即可成功；
#   但同时传 `-Settings` 会报
#   `The task XML is missing a required element or attribute. (52,8):Count:`
#   —— 生成的 `<RestartOnFailure>` 缺 `<Count>`。需要改设置时请显式给出
#   `-RestartCount` / `-RestartInterval`，或干脆别传 -Settings。
# - `Register-ScheduledTask -Force` 覆盖注册需要管理员；只想修触发器时
#   优先用下面的 Set-ScheduledTask 分支，不必提权。

$action = New-ScheduledTaskAction -Execute $powershell `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$watchdog`""

# 时间触发器 + 每分钟重复。注意用 -Daily 而不是 -AtLogOn（见第 3 层）。
$trigger = New-ScheduledTaskTrigger -Daily -At 00:00
$repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date).Date `
    -RepetitionInterval (New-TimeSpan -Minutes 1) `
    -RepetitionDuration (New-TimeSpan -Days 3650)).Repetition
$repetition.StopAtDurationEnd = $false
$trigger.Repetition = $repetition

$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
  # 任务已存在：只换触发器（普通权限可用，且不会碰到 -Settings 的 XML 坑）。
  Set-ScheduledTask -TaskName $taskName -Trigger $trigger | Out-Null
  Write-Output "updated trigger of $taskName"
} else {
  # 首次安装：需要管理员权限。
  # 短命任务不需要长时限；10 分钟足够覆盖偶发慢检查。
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Settings $settings -Force | Out-Null
  Write-Output "registered $taskName"
}

Start-ScheduledTask -TaskName $taskName

$info = Get-ScheduledTaskInfo -TaskName $taskName
Write-Output "NextRunTime = $($info.NextRunTime)"
Write-Output "trigger = $((Get-ScheduledTask -TaskName $taskName).Triggers[0].Repetition.Interval) / stopAtDurationEnd=$((Get-ScheduledTask -TaskName $taskName).Triggers[0].Repetition.StopAtDurationEnd)"
Write-Output "校验：NextRunTime 为空说明重复没生效；应能看到每 1 分钟一次的时间点。"
