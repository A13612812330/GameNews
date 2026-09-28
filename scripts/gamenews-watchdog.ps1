param(
  # -Resident：进入常驻循环（本机手动 debug 时用）。
  # 不加参数 = 做一次健康检查就退出 —— 这正是计划任务的调用方式。
  # 之所以让「无参数」表示一次性：任务动作无法修改
  # （Set-ScheduledTask -Action 被拒 Access denied），只能让脚本默认行为即所需行为。
  [switch]$Resident
)

$ErrorActionPreference = "Continue"
$projectRoot = Split-Path -Parent $PSScriptRoot
$logRoot = Join-Path $projectRoot "logs"
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
$watchdogLog = Join-Path $logRoot "watchdog.log"

# Supervisor for 64424 (API + built frontend) and 64425 (public poster service).
#
# 2026-09-28 演进记录（两层问题，都踩过）：
#   1) 最初的任务是 /SC ONLOGON —— 只在登录时跑一次。守护本身是常驻循环，
#      一旦被杀就再也没人重启它（实测 09-21 之后长期停摆）。
#      修法：触发器加「每 N 分钟重复」，让任务负责反复拉起守护。
#   2) 但任务动作直接写 powershell.exe -File watchdog.ps1 时，任务实例与那个
#      PowerShell 绑定，实测任务会以 0xC000013A (STATUS_CONTROL_C_EXIT) 提前结束，
#      守护随之消失（日志只留下 "watchdog start" 一行）。
#      修法（当前方案）：不要再依赖常驻 —— 改成「一次性健康检查 + 任务每分钟调用」。
#      进程短命、正常退出（result 0），完全绕开「常驻进程被任务实例终止」。
#      代价是每分钟起一个 PowerShell，开销可忽略；服务最多中断 1 分钟即被拉回。
#
# 反证测试（必须做，别只看任务状态）：
#   杀掉 64424 → 等 ≤70 秒 → 端口应重新监听，且日志出现 started server/index.js。
function Write-WatchdogLog([string]$Message) {
  try {
    Add-Content -Path $watchdogLog -Value "$(Get-Date -Format o) $Message" -ErrorAction SilentlyContinue
  } catch { }
}

function Test-Port([int]$Port) {
  try {
    return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
  } catch {
    return $false
  }
}

function Start-ManagedProcess($Name, $FilePath, $ArgumentList, $WorkingDirectory, $StdOut, $StdErr) {
  try {
    $existing = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and $_.CommandLine -like "*$WorkingDirectory*" -and $_.CommandLine -like "*$Name*" } |
      Select-Object -First 1
    if ($existing) {
      Write-WatchdogLog "reuse existing $Name pid=$($existing.ProcessId)"
      return [int]$existing.ProcessId
    }
    $proc = Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -WorkingDirectory $WorkingDirectory -RedirectStandardOutput $StdOut -RedirectStandardError $StdErr -WindowStyle Hidden -PassThru -ErrorAction Stop
    Write-WatchdogLog "started $Name pid=$($proc.Id)"
    return [int]$proc.Id
  } catch {
    Write-WatchdogLog "START FAILED $Name : $($_.Exception.Message)"
    return 0
  }
}

$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = "D:\NodeJS\node.exe" }
$npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if (-not $npm) { $npm = "D:\NodeJS\npm.cmd" }
$serverOut = Join-Path $logRoot "server-watchdog.log"
$serverErr = Join-Path $logRoot "server-watchdog.err.log"
$publicOut = Join-Path $logRoot "poster-public-watchdog.log"
$publicErr = Join-Path $logRoot "poster-public-watchdog.err.log"
$clientOut = Join-Path $logRoot "client-watchdog.log"
$clientErr = Join-Path $logRoot "client-watchdog.err.log"

# 64423 是 Vite 开发服务器（只有 HMR），日常不需要：
# server/index.js 已用 express.static(dist) 托管构建产物。
# 仅在显式设置 GAMENEWS_DEV_CLIENT=1 时才一并守着它。
$withDevClient = $env:GAMENEWS_DEV_CLIENT -eq "1"

$script:serverBootAt = $null
$script:publicBootAt = $null
$script:clientBootAt = $null

function Invoke-HealthCheck {
  if (-not (Test-Port 64424)) {
    $grace = $script:serverBootAt -and ((Get-Date) - $script:serverBootAt).TotalSeconds -lt 60
    if (-not $grace) {
      Start-ManagedProcess "server/index.js" $node @("server/index.js") $projectRoot $serverOut $serverErr | Out-Null
      $script:serverBootAt = Get-Date
    }
  } else {
    $script:serverBootAt = $null
  }

  if (-not (Test-Port 64425)) {
    $grace2 = $script:publicBootAt -and ((Get-Date) - $script:publicBootAt).TotalSeconds -lt 60
    if (-not $grace2) {
      Start-ManagedProcess "poster-public-server.mjs" $node @("scripts/poster-public-server.mjs") $projectRoot $publicOut $publicErr | Out-Null
      $script:publicBootAt = Get-Date
    }
  } else {
    $script:publicBootAt = $null
  }

  if ($withDevClient) {
    if (-not (Test-Port 64423)) {
      $grace3 = $script:clientBootAt -and ((Get-Date) - $script:clientBootAt).TotalSeconds -lt 60
      if (-not $grace3) {
        Start-ManagedProcess "dev:client" $npm @("run", "dev:client", "--", "--host", "127.0.0.1") $projectRoot $clientOut $clientErr | Out-Null
        $script:clientBootAt = Get-Date
      }
    } else {
      $script:clientBootAt = $null
    }
  }
}

# 单实例保护：即使被重复触发（任务重复触发 + 手动调用叠加），
# 也只有一个检查在真正执行；抢不到锁就直接退出。
$mutexCreated = $false
try {
  $watchdogMutex = New-Object System.Threading.Mutex($true, "Local\GameNewsWatchdog", [ref]$mutexCreated)
} catch {
  $mutexCreated = $true
}
if (-not $mutexCreated) {
  exit 0
}

if (-not $Resident) {
  # 计划任务以「无参数」方式调用：跑一次健康检查即退出。
  # 短命进程 + 正常退出（result 0），彻底绕开「常驻进程被任务实例终止」的问题。
  try {
    Invoke-HealthCheck
  } catch {
    Write-WatchdogLog "CHECK ERROR: $($_.Exception.Message)"
  }
  exit 0
}

Write-WatchdogLog "watchdog resident start devClient=$withDevClient node=$node"
while ($true) {
  try {
    Invoke-HealthCheck
  } catch {
    Write-WatchdogLog "LOOP ERROR: $($_.Exception.Message)"
  }
  Start-Sleep -Seconds 8
}
