$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$watchdog = Join-Path $projectRoot "scripts\gamenews-watchdog.ps1"
$taskName = "Komo-GameNews-Watchdog"
$powershell = Join-Path $PSHOME "powershell.exe"
if (-not (Test-Path $powershell)) { $powershell = "powershell.exe" }

# 2026-09-28 的两层修正：
#
# 第 1 层：最早的任务是 /SC ONLOGON —— 只在登录时跑一次。守护本身是常驻循环，
# 被杀后再没人重启（实测最后运行 09-21 14:25，结果码 3221225786
# = STATUS_CONTROL_C_EXIT，之后长期无人守护）。
# 修法：给触发器加「每 N 分钟重复」，让任务负责反复拉起。
#
# 第 2 层：加了重复触发后仍不行 —— 任务动作直接写
# powershell.exe -File watchdog.ps1 时，任务实例与那个 PowerShell 绑定，
# 实测会以 0xC000013A 提前结束，守护随之消失（日志只留一行 start）。
# 修法（当前方案）：不再依赖常驻。脚本默认行为改成「一次健康检查后退出」，
# 由任务每分钟调用一次。进程短命、正常退出（result 0），
# 彻底绕开「常驻进程被任务实例终止」这一整类问题；服务最多中断 1 分钟。
#
# 任务动作**不带参数**（脚本无参数即一次性检查）；常驻模式改用 -Resident
# 显式开启，只在需要本机盯着看的时候用。
#
# 权限提示：实测普通用户会话下 `Set-ScheduledTask -Action / -Trigger`
# 可能被拒 Access denied（不同调用时结果不一致），所以本脚本请用管理员运行；
# 只想改触发器时可先单独试 Set-ScheduledTask -Trigger。

$action = New-ScheduledTaskAction -Execute $powershell `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$watchdog`""

$trigger = New-ScheduledTaskTrigger -AtLogOn
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 1) `
    -RepetitionDuration (New-TimeSpan -Days 3650)).Repetition

# 短命任务不需要长时限；10 分钟足够覆盖偶发慢检查，
# 同时避开 PT0S 在部分系统上被当成「立即超时」的歧义。
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Settings $settings -Force | Out-Null

Start-ScheduledTask -TaskName $taskName

Write-Output "rebuilt and started $taskName (every 1 min one-shot health check; re-registering needs admin)"
