$conn = Get-NetTCPConnection -State Listen -LocalPort 64424 -ErrorAction SilentlyContinue
if (-not $conn) { throw '未找到64424服务' }
$oldProcessId = $conn.OwningProcess
Stop-Process -Id $oldProcessId -Force
Start-Sleep -Seconds 2
$node = (Get-Command node.exe).Source
$out = (Resolve-Path data/logs).Path + '\server.stdout.log'
$err = (Resolve-Path data/logs).Path + '\server.stderr.log'
Start-Process -FilePath $node -ArgumentList 'server/index.js' -WorkingDirectory (Get-Location) -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err | Out-Null
Start-Sleep -Seconds 4
$newConn = Get-NetTCPConnection -State Listen -LocalPort 64424 -ErrorAction SilentlyContinue
$health = Invoke-RestMethod http://127.0.0.1:64424/api/health
[pscustomobject]@{
  oldPid = $oldProcessId
  newPid = if ($newConn) { $newConn.OwningProcess } else { '' }
  listening = [bool]$newConn
  health = $health.ok
  pause = [Environment]::GetEnvironmentVariable('FEISHU_TOPIC_NOTIFICATIONS_PAUSED','User')
} | ConvertTo-Json -Compress
