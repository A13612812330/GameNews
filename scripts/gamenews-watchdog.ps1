$ErrorActionPreference = "Continue"
$projectRoot = Split-Path -Parent $PSScriptRoot
$logRoot = Join-Path $projectRoot "logs"
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null

function Test-Port([int]$Port) {
  return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Start-ManagedProcess($Name, $FilePath, $ArgumentList, $WorkingDirectory, $StdOut, $StdErr) {
  $existing = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$WorkingDirectory*" -and $_.CommandLine -like "*$Name*" } |
    Select-Object -First 1
  if ($existing) { return [int]$existing.ProcessId }
  $proc = Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -WorkingDirectory $WorkingDirectory -RedirectStandardOutput $StdOut -RedirectStandardError $StdErr -WindowStyle Hidden -PassThru
  Add-Content -Path (Join-Path $logRoot "watchdog.log") -Value "$(Get-Date -Format o) started $Name pid=$($proc.Id)"
  return [int]$proc.Id
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
$serverPid = 0
$publicPid = 0
$clientPid = 0

# 64423 is the Vite dev server (HMR only). It is NOT required for normal use:
# server/index.js already serves the built frontend through express.static(dist),
# so http://127.0.0.1:64424 renders the same UI with one listener instead of two.
# It used to be kept alive 24/7, which held a port permanently and re-ran Vite on
# every file change. It is now opt-in -- set GAMENEWS_DEV_CLIENT=1 before starting
# this watchdog when you want live-reload while editing frontend source.
$withDevClient = $env:GAMENEWS_DEV_CLIENT -eq "1"
Add-Content -Path (Join-Path $logRoot "watchdog.log") -Value "$(Get-Date -Format o) watchdog start devClient=$withDevClient"

while ($true) {
  $serverAlive = $serverPid -and (Get-Process -Id $serverPid -ErrorAction SilentlyContinue)
  if (-not $serverAlive -and -not (Test-Port 64424)) {
    $serverPid = Start-ManagedProcess "server/index.js" $node @("server/index.js") $projectRoot $serverOut $serverErr
  }
  # 公开只读海报服务（cloudflared 隧道指向它）。它不依赖 64424，但必须常驻：
  # 它负责把图片代理地址改写成同源 /assets 或 /image，一旦挂掉分享链接就白图。
  $publicAlive = $publicPid -and (Get-Process -Id $publicPid -ErrorAction SilentlyContinue)
  if (-not $publicAlive -and -not (Test-Port 64425)) {
    $publicPid = Start-ManagedProcess "poster-public-server.mjs" $node @("scripts/poster-public-server.mjs") $projectRoot $publicOut $publicErr
  }
  if ($withDevClient) {
    $clientAlive = $clientPid -and (Get-Process -Id $clientPid -ErrorAction SilentlyContinue)
    if (-not $clientAlive -and -not (Test-Port 64423)) {
      $clientPid = Start-ManagedProcess "dev:client" $npm @("run", "dev:client", "--", "--host", "127.0.0.1") $projectRoot $clientOut $clientErr
    }
  }
  Start-Sleep -Seconds 8
}
