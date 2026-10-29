# GameNewsUnified 问题处理回传（Codex → TraeWork）

> 处理时间：2026-08-27
> 正式目录：`E:\新建文件夹\Codex-GPT\GameNewsUnified`
> 本轮不停止旧 `GameNews` 双跑，不读取或输出任何密钥。

## 总结

P0 已恢复运行并完成首轮调度验证；P4 通过；P1 和 P2 不应标记为完成；P3 已定位副本差异。

## P0：服务常驻

### 已完成

- 新增守护脚本：`scripts/run-unified-service.ps1`。
  - 同时守护 API 与 scheduler。
  - API 固定监听 `64504`。
  - 任一 Node 子进程退出后，5 秒后自动重启。
  - 日志落盘至 `logs/service-supervisor.log`、`logs/api-server-*.{out,err}.log`、`logs/scheduler-*.{out,err}.log`。
- 已即时启动守护，当前健康检查通过：`GET http://127.0.0.1:64504/api/health` 返回 `ok: true`。
- 已执行 API 进程故障演练：旧 PID `33992` 被停止后，守护在约 5 秒后拉起 PID `31824`，健康检查恢复正常。
- scheduler 首轮 monitor 已完成：6 个来源均 `ok`，随后完成飞书增量同步；本轮没有 S/A 安全新增，因此没有发送提醒。
- 新增当前用户登录自启入口：
  `C:\Users\komo\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\GameNewsUnified-Service.cmd`

### 调度修复

`server/tasks/scheduler.mjs` 已补齐 `activeHours` 限制。原来配置虽写明 monitor 仅在 `08:00-23:00` 运行，但守护循环未实际判断；现已按该时段执行，避免夜间额外采集。

### 仍需管理员动作

本会话创建 Windows 计划任务（`SYSTEM` 开机触发和当前用户 ONLOGON）均被系统返回 `Access is denied` 拒绝。因此，**真正的未登录开机自启尚未完成**。

当前用户登录自启已配置；如需机器开机后、未登录也启动，请用管理员 PowerShell 创建 `GameNewsUnified-Service` 计划任务，并运行：

```powershell
$script = 'E:\新建文件夹\Codex-GPT\GameNewsUnified\scripts\run-unified-service.ps1'
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes("& '$script'"))
schtasks /Create /TN "GameNewsUnified-Service" /SC ONSTART /RU SYSTEM /RL HIGHEST /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand $encoded" /F
```

## P1：海报公网外链（未完成）

- `POSTER_BASE_URL` 已配置，但主机为 `127.0.0.1`，不是公网地址。
- 机器已安装 `cloudflared.exe`，当前没有运行中的 Cloudflare Tunnel。
- 海报机器人凭据完整；话题提醒未暂停。

结论：飞书群内目前不能依靠本机地址打开海报链接。不要用会在重启后变更地址的 quick tunnel 作为正式方案；需要配置命名 Cloudflare Tunnel、稳定域名和 `POSTER_BASE_URL` 后再验收。

## P2：迁移切换（不切换）

旧项目双跑覆盖仍为 10/12，缺少《星球大战：银河赛车手》和《Trees Hate Y》两条。当前不停止旧 `GameNews` 双跑，也不把统一项目标记为全权接管。应完成 URL 12/12 覆盖及 `西游大冒险` event 缺失处理后再评估切换。

## P3：副本一致性

核对目录：

- 正式：`E:\新建文件夹\Codex-GPT\GameNewsUnified`
- TraeWork：`E:\新建文件夹\TraeWork\6a8e97b0c36a13e47a2f964a\GameNewsUnified`

`server/`、`tests/`、`schema.sql` 全量 SHA-256 比对结果：

| 状态 | 文件 | 说明 |
| --- | --- | --- |
| 内容不同 | `server/tasks/scheduler.mjs` | 正式目录新增 `activeHours` 实际约束。需回同步给 TraeWork。 |
| 内容不同 | `package.json` | 正式目录已包含 React/Vite、lucide 等前端依赖与 `build` / `dev:web` 脚本；TraeWork 副本仍是精简后端依赖。 |

除上述两项外，`server/` 其余文件、`tests/` 和 `schema.sql` 一致。

## P4：390px 前端验收（通过）

使用 Playwright 在 `390 × 844` 视口验证：

| 页面 | `scrollWidth` | `clientWidth` | 结果 |
| --- | ---: | ---: | --- |
| `/` | 390 | 390 | 无横向溢出 |
| `/admin/tasks` | 390 | 390 | 无横向溢出 |

未需要 CSS 改动。

## P5

- `FEISHU_POSTER_APP_ID`、Secret、Chat ID 均已配置（仅核验存在性，未读取或输出值）。
- `FEISHU_TOPIC_NOTIFICATIONS_PAUSED` 未设为 `1`，符合 S/A 默认可发送的既有要求。
- batch delete 本轮未使用；后续若实现删除接口，继续采用 POST。

## 验证

- `npm run build`：通过。
- `npm test`：56/56 通过，0 failed。
- `GET /api/health`：通过。
- scheduler 首轮：6 来源聚合均成功。

## 本轮改动清单

| 文件 | 原因 |
| --- | --- |
| `server/tasks/scheduler.mjs` | 落实 monitor 的 08:00-23:00 配置。 |
| `scripts/run-unified-service.ps1` | 增加 API + scheduler 常驻守护与日志。 |
| `C:\Users\komo\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\GameNewsUnified-Service.cmd` | 当前用户登录自启。 |
| 本文件 | 处理结果回传。 |
