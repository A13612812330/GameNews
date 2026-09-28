$ErrorActionPreference = "Continue"
$projectRoot = Split-Path -Parent $PSScriptRoot
$logRoot = Join-Path $projectRoot "logs"
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
$watchdogLog = Join-Path $logRoot "watchdog.log"

# Resident supervisor for 64424 (API + built frontend) and 64425 (public poster
# service). 2026-09-28 hardening:
#   1) every loop body is wrapped in try/catch. Previously a single throwing
#      iteration (e.g. Start-Process failing in a non-interactive scheduled-task
#      session) killed the whole script, and the log ended with no trace of why,
#      leaving 64424 / 64425 unsupervised.
#   2) start failures are logged instead of silently propagated.
#   3) port state is the only liveness signal, with a 60s grace window after a
#      spawn attempt so a still-booting service is not spawned twice.

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
$serverBootAt = $null
$publicBootAt = $null
$clientBootAt = $null

# 64423 is the Vite dev server (HMR only) and is NOT required for normal use:
# server/index.js already serves the built frontend via express.static(dist).
# It is opt-in -- set GAMENEWS_DEV_CLIENT=1 before starting this watchdog.
$withDevClient = $env:GAMENEWS_DEV_CLIENT -eq "1"

Write-WatchdogLog "watchdog start devClient=$withDevClient node=$node"

while ($true) {
  try {
    if (-not (Test-Port 64424)) {
      $grace = $serverBootAt -and ((Get-Date) - $serverBootAt).TotalSeconds -lt 60
      if (-not $grace) {
        Start-ManagedProcess "server/index.js" $node @("server/index.js") $projectRoot $serverOut $serverErr | Out-Null
        $serverBootAt = Get-Date
      }
    } else {
      $serverBootAt = $null
    }

    if (-not (Test-Port 64425)) {
      $grace2 = $publicBootAt -and ((Get-Date) - $publicBootAt).TotalSeconds -lt 60
      if (-not $grace2) {
        Start-ManagedProcess "poster-public-server.mjs" $node @("scripts/poster-public-server.mjs") $projectRoot $publicOut $publicErr | Out-Null
        $publicBootAt = Get-Date
      }
    } else {
      $publicBootAt = $null
    }

    if ($withDevClient) {
      if (-not (Test-Port 64423)) {
        $grace3 = $clientBootAt -and ((Get-Date) - $clientBootAt).TotalSeconds -lt 60
        if (-not $grace3) {
          Start-ManagedProcess "dev:client" $npm @("run", "dev:client", "--", "--host", "127.0.0.1") $projectRoot $clientOut $clientErr | Out-Null
          $clientBootAt = Get-Date
        }
      } else {
        $clientBootAt = $null
      }
    }
  } catch {
    Write-WatchdogLog "LOOP ERROR: $($_.Exception.Message)"
  }
  Start-Sleep -Seconds 8
}
