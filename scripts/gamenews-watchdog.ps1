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
$clientOut = Join-Path $logRoot "client-watchdog.log"
$clientErr = Join-Path $logRoot "client-watchdog.err.log"
$serverPid = 0
$clientPid = 0

while ($true) {
  $serverAlive = $serverPid -and (Get-Process -Id $serverPid -ErrorAction SilentlyContinue)
  if (-not $serverAlive -and -not (Test-Port 64424)) {
    $serverPid = Start-ManagedProcess "server/index.js" $node @("server/index.js") $projectRoot $serverOut $serverErr
  }
  $clientAlive = $clientPid -and (Get-Process -Id $clientPid -ErrorAction SilentlyContinue)
  if (-not $clientAlive -and -not (Test-Port 64423)) {
    $clientPid = Start-ManagedProcess "dev:client" $npm @("run", "dev:client", "--", "--host", "127.0.0.1") $projectRoot $clientOut $clientErr
  }
  Start-Sleep -Seconds 8
}
