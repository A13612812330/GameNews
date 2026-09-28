$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$sourceRoot = Join-Path $projectRoot "output\scheduled-posters"
$publishRoot = Join-Path $projectRoot "published-posters"
$dailyRoot = Join-Path $publishRoot "daily"
$weeklyRoot = Join-Path $publishRoot "weekly"

if (-not (Test-Path -LiteralPath (Join-Path $projectRoot ".git"))) {
  throw "当前目录尚未初始化 Git 仓库。"
}
if (-not (Test-Path -LiteralPath $sourceRoot)) {
  throw "未找到海报输出目录：$sourceRoot"
}

New-Item -ItemType Directory -Force -Path $dailyRoot, $weeklyRoot | Out-Null

# 先把海报里的本机图片地址落地成归档内的相对路径副本：
#   127.0.0.1:64424/weekly-assets/...  →  复制 data/weekly-snapshots/... 的本地快照
#   127.0.0.1:64424/api/image-proxy?..  →  服务端代取原始图
# 不这么做的话，推到 GitHub 后外部访客打开就是满屏破图（本机地址指向他自己电脑）。
# 详见 scripts/archive-posters-selfcontained.mjs。
$archiveScript = Join-Path $projectRoot "scripts\archive-posters-selfcontained.mjs"
if (Test-Path -LiteralPath $archiveScript) {
  $nodeExe = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
  if (-not $nodeExe) { $nodeExe = "D:\NodeJS\node.exe" }
  & $nodeExe $archiveScript
  if ($LASTEXITCODE -ne 0) { throw "海报归档自包含失败（node exit $LASTEXITCODE）" }
}

function Sync-PosterFiles([string]$Pattern, [string]$Destination) {
  $changed = 0
  Get-ChildItem -LiteralPath $sourceRoot -File | Where-Object { $_.Name -match $Pattern } | ForEach-Object {
    $target = Join-Path $Destination $_.Name
    $needsCopy = -not (Test-Path -LiteralPath $target)
    if (-not $needsCopy) {
      $needsCopy = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
    }
    if ($needsCopy) {
      Copy-Item -LiteralPath $_.FullName -Destination $target -Force
      $changed += 1
    }
  }
  return $changed
}

$dailyChanged = Sync-PosterFiles '^\d{4}\.\d{1,2}\.\d{1,2}-今日简讯海报\.(html|png)$' $dailyRoot
$weeklyChanged = Sync-PosterFiles '^\d{4}\.\d{1,2}\.\d{1,2}-周简讯海报\.html$' $weeklyRoot

Set-Location $projectRoot
git add -- published-posters
git diff --cached --quiet
if ($LASTEXITCODE -eq 0) {
  Write-Output "无需推送：日报与周报归档没有变化。"
  exit 0
}

$stamp = Get-Date -Format "yyyy-MM-dd"
git commit -m "chore(posters): sync $stamp"
git push origin main
Write-Output "已推送：日报 $dailyChanged 个文件，周报 $weeklyChanged 个文件。"
