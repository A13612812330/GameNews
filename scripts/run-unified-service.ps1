<#
  GameNewsUnified 常驻守护。
  由 Windows 计划任务 GameNewsUnified-Service 在开机时启动。
  负责同时守护正式 API（64504）与 scheduler；任一 Node 子进程退出后自动重启。
  不读取、不打印 .env.local；子进程自行按项目既有 env.mjs 加载配置。
#>
[CmdletBinding()]
param(
  [string]$ProjectRoot,
  [int]$RestartDelaySeconds = 5
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
  $ProjectRoot = Split-Path -Parent $PSScriptRoot
}
$logDir = Join-Path $ProjectRoot 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$nodeCandidates = @(
  @(
    $(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles 'nodejs\node.exe' }),
    'D:\NodeJS\node.exe',
    'C:\Program Files\nodejs\node.exe'
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
)
if (-not $nodeCandidates) { throw '未找到 node.exe；请安装 Node.js 后重新运行计划任务。' }
$node = $nodeCandidates[0]

function Write-ServiceLog([string]$message) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $message"
  Add-Content -LiteralPath (Join-Path $logDir 'service-supervisor.log') -Value $line -Encoding UTF8
}

function Start-ManagedNode([string]$name, [string[]]$arguments, [hashtable]$environment = @{}) {
  foreach ($entry in $environment.GetEnumerator()) { Set-Item -Path "Env:$($entry.Key)" -Value $entry.Value }
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $out = Join-Path $logDir "$name-$stamp.out.log"
  $err = Join-Path $logDir "$name-$stamp.err.log"
  $process = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $ProjectRoot -RedirectStandardOutput $out -RedirectStandardError $err -PassThru -WindowStyle Hidden
  Write-ServiceLog "[$name] started pid=$($process.Id) out=$([IO.Path]::GetFileName($out)) err=$([IO.Path]::GetFileName($err))"
  return $process
}

Write-ServiceLog "supervisor started root=$ProjectRoot node=$node"
$api = $null
$scheduler = $null
while ($true) {
  try {
    if (-not $api -or $api.HasExited) {
      if ($api) { Write-ServiceLog "[api-server] exited code=$($api.ExitCode); restarting"; Start-Sleep -Seconds $RestartDelaySeconds }
      $api = Start-ManagedNode -name 'api-server' -arguments @('server/api-server.mjs') -environment @{ GN_PORT = '64504' }
    }
    if (-not $scheduler -or $scheduler.HasExited) {
      if ($scheduler) { Write-ServiceLog "[scheduler] exited code=$($scheduler.ExitCode); restarting"; Start-Sleep -Seconds $RestartDelaySeconds }
      $scheduler = Start-ManagedNode -name 'scheduler' -arguments @('server/tasks/scheduler.mjs')
    }
  } catch {
    Write-ServiceLog "supervisor error: $($_.Exception.Message)"
    Start-Sleep -Seconds ([Math]::Max($RestartDelaySeconds, 15))
  }
  Start-Sleep -Seconds 3
}
