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
