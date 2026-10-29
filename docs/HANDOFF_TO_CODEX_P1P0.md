# 交接给 Codex：P1 公网海报 + P0 SYSTEM 自启

> 日期：2026-08-27
> 来源：TO_TRAEWORK_NEXT_ACTIONS.md 中 TraeWork 无法独立完成的两项，转交 Codex 处理。
> 正式运行目录：`E:\新建文件夹\Codex-GPT\GameNewsUnified`

## 一、P1：正式公网海报地址（需要 Cloudflare 凭据/域名）

### 现状
- `POSTER_BASE_URL` 当前为本机 `127.0.0.1`（写于正式目录 `.env.local`），飞书群外无法打开海报外链。
- 海报 PNG 仍由本机 Microsoft Edge headless 生成，不受影响。

### 要求（不可用 quick tunnel）
1. 建立**命名 Cloudflare Tunnel + 稳定域名**，指向 `http://127.0.0.1:64504`。
2. 正式域名下可访问 `/output/...` 海报 HTML。
3. 仅在取得 Tunnel 凭据/稳定域名后，将公网地址写入正式目录 `.env.local` 的 `POSTER_BASE_URL`。
4. 凭据不进入代码、文档、日志或 Git。

### 可参考的既有资源（旧项目）
- `E:\新建文件夹\Codex-GPT\GameNews\tools\cloudflared\cloudflared.exe`（cloudflared 可执行文件）
- 旧项目 `data/poster-public-tunnel.json` / `data/poster-public-tunnel.log`（旧项目曾做过公网海报隧道，可参考其域名与配置；**读取时注意其中可能含令牌，不要打印或提交到任何地方**）

### 验收
- 飞书消息中的海报 URL 在非本机网络可访问。
- PNG 仍由本机生成；`POSTER_BASE_URL` 只在确认可用后更新。

## 二、P0：SYSTEM 级开机自启（需要管理员权限）

### 现状
- 用户登录自启已存在：`C:\Users\komo\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\GameNewsUnified-Service.cmd`
- 当前会话无管理员权限，无法创建 SYSTEM 级计划任务；"电脑开机、未登录也常驻"未完成。

### 需要的操作（管理员 PowerShell）
```powershell
$script = 'E:\新建文件夹\Codex-GPT\GameNewsUnified\scripts\run-unified-service.ps1'
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes("& '$script'"))
schtasks /Create /TN "GameNewsUnified-Service" /SC ONSTART /RU SYSTEM /RL HIGHEST /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand $encoded" /F
```
> 注意：`run-unified-service.ps1` 只启动 `server/api-server.mjs`（GN_PORT=64504）与 `server/tasks/scheduler.mjs`，不读取 `.env.local`；子进程自行加载配置，密钥不进任务计划参数。

### 验收
- 重启后 64504 正常监听，`/api/health` 返回 `ok: true`。
- `logs/service-supervisor.log` 有新的启动记录。

## 三、附带建议（非阻塞，供 Codex 评估）

1. **游民星空（pc-news）漏采**：08-27 凌晨《星球大战：银河赛车手》《Trees Hate You》因游民首页列表窗口滚动未被统一采集器抓到，TraeWork 已用 `backfill-cover.mjs` 从旧库幂等回填（两库均 12/12 URL 覆盖、西游大冒险 event 已建）。建议后续评估 pc-news 是否加列表分页或放宽日期窗口，避免未来凌晨文章再次漏采。
2. TraeWork 工作区留有可复现证据脚本：`backfill-cover.mjs`（幂等回填）、`audit-url-cover.mjs --db <路径>`（12 条 URL 覆盖核对）。
