$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$sourceRoot = Join-Path $projectRoot "output\scheduled-posters"
$publishRoot = Join-Path $projectRoot "published-posters"
$dailyRoot = Join-Path $publishRoot "daily"
$weeklyRoot = Join-Path $publishRoot "weekly"
$logRoot = Join-Path $projectRoot "data\logs\github-posters"
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
$statusPath = Join-Path $logRoot "latest.json"
$transcriptPath = Join-Path $logRoot ((Get-Date -Format "yyyy-MM-dd-HHmmss") + ".log")
$transcriptStarted = $false

function Invoke-CheckedGit {
  param([string[]]$GitArgs)
  $result = & git @GitArgs
  if ($LASTEXITCODE -ne 0) { throw "git $($GitArgs -join ' ') failed (exit $LASTEXITCODE)" }
  return $result
}

try {
Start-Transcript -LiteralPath $transcriptPath | Out-Null
$transcriptStarted = $true
Set-Location -LiteralPath $projectRoot
$branch = (Invoke-CheckedGit -GitArgs @("branch", "--show-current")).Trim()
if (-not $branch) { throw "Detached HEAD: refusing to guess the publication branch." }
# Keep unrelated staged changes out of an automated commit.
$staged = @(Invoke-CheckedGit -GitArgs @("diff", "--cached", "--name-only"))
if ($staged | Where-Object { $_ -notmatch '^published-posters/' }) {
  throw "Unrelated staged files exist; refusing to commit them."
}
# Public archives were explicitly approved. Credentials and runtime data remain local.
$origin = (Invoke-CheckedGit -GitArgs @("remote", "get-url", "origin")).Trim()
if ($origin -notmatch '^(https://github\.com/|git@github\.com:)A13612812330/GameNews(?:\.git)?$') {
  throw "Unexpected publication remote; refusing to upload."
}

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

# The archive builder already writes self-contained HTML and PNGs. Copying the
# original HTML afterwards would restore localhost image URLs and break it again.
if (-not (Test-Path -LiteralPath $archiveScript)) {
  throw "Missing self-contained archive builder."
}
& $nodeExe (Join-Path $projectRoot "scripts\verify-poster-publication.mjs")
if ($LASTEXITCODE -ne 0) { throw "Public archive safety validation failed." }

Set-Location $projectRoot
Invoke-CheckedGit -GitArgs @("add", "--", "published-posters") | Out-Null
git diff --cached --quiet
if ($LASTEXITCODE -eq 1) {
  $stamp = Get-Date -Format "yyyy-MM-dd"
  Invoke-CheckedGit -GitArgs @("diff", "--cached", "--check") | Out-Null
  Invoke-CheckedGit -GitArgs @("commit", "-m", "chore(posters): sync $stamp")
} elseif ($LASTEXITCODE -ne 0) {
  throw "Cannot inspect staged archive changes."
}

# Retry pending commits even when today's files have not changed.
$localSha = (Invoke-CheckedGit -GitArgs @("rev-parse", "HEAD")).Trim()
Invoke-CheckedGit -GitArgs @("push", "origin", "HEAD:refs/heads/$branch")
$remote = @(Invoke-CheckedGit -GitArgs @("ls-remote", "origin", "refs/heads/$branch"))
if (-not $remote.Count -or ($remote[0] -split '\s+')[0] -ne $localSha) {
  throw "GitHub remote commit does not match the local archive commit."
}
@{ ok = $true; finishedAt = [DateTimeOffset]::UtcNow.ToString("o"); branch = $branch; commit = $localSha; log = $transcriptPath } |
  ConvertTo-Json | Set-Content -LiteralPath $statusPath -Encoding UTF8
Write-Output "Uploaded and verified: $branch @ $localSha"
} catch {
  @{ ok = $false; finishedAt = [DateTimeOffset]::UtcNow.ToString("o"); error = $_.Exception.Message; log = $transcriptPath } |
    ConvertTo-Json | Set-Content -LiteralPath $statusPath -Encoding UTF8
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
} finally {
  if ($transcriptStarted) { Stop-Transcript | Out-Null }
}
