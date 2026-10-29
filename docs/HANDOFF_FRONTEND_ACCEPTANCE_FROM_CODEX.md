# 前端收敛验收接续（Codex → TraeWork）

> 验收时间：2026-08-27
> 验收范围：`HANDOFF_FRONTEND_CONVERGENCE.md` 中 T1–T4。
> 边界：未修改样式、未停止旧 `GameNews` 双跑、未读取或改写 `.env.local`。

## 结论

**T1、T2、T4 通过；T3 仅部分通过。**

正式服务应继续使用 **`http://127.0.0.1:64504/`**。旧 `64503` 已停止。

在迁移切换前，仍需保留旧 `GameNews` 双跑。另有两项必须进入下一轮修复：旧静态资源仍可被 64504 直接访问；飞书真实提醒缺少本地投递审计记录。

## T1：页面与任务聚合验证（通过）

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| 资讯首页 `/` | 通过 | HTTP 200；存在 `#root` 和 Vite `/assets/*.js`；`docs/screenshots/home.png` 显示首页内容，非白屏。 |
| 任务页 `/admin/tasks` | 通过 | HTTP 200；`docs/screenshots/admin-tasks.png` 显示任务卡及 6 个子来源。 |
| 飞书页 `/admin/feishu` | 通过 | HTTP 200；`docs/screenshots/admin-feishu.png` 显示评级来源分布和通知区。 |
| monitor 最近一轮 | 通过 | `GET /api/admin/tasks` 返回 6 个子来源，当前均为 `ok`：gamersky 16、gcores 5、haoyou 40、steam 15、taptap 0、x7 6。 |
| 部分失败规则 | 代码级通过 | `server/api-server.mjs:94-103`：任一来源非 `ok` 时聚合为 `partial`，并将失败来源与错误写入 `lastError`。本轮无真实失败来源，尚无“部分失败”页面实景截图。 |

## T2：端口收敛（通过）

- `64503`：旧进程 PID 23596 已停止；端口不再监听，访问被拒绝。
- `64504`：仍在监听，返回 React/Vite 构建页面及新管理 API。
- 正式运行目录：`E:\新建文件夹\Codex-GPT\GameNewsUnified`
- 正式启动命令：`$env:GN_PORT='64504'; node server/api-server.mjs`

## T3：旧静态前端隔离（部分通过，需修复）

React 的 `dist/index.html` 已成为 `/` 和前端路由的入口，旧的静态页面并未作为主页面加载。

但严格按“静态前端不再服务”验收，**当前未完全达标**：

- `http://127.0.0.1:64504/app.js` 返回 HTTP 200（旧 `public/app.js`）
- `http://127.0.0.1:64504/styles.css` 返回 HTTP 200（旧 `public/styles.css`）

原因是 `server/api-server.mjs:278-279` 仍保留了 `PUBLIC_DIR` 文件回退。建议下一轮删除该通用回退，或至少显式拒绝 `/app.js`、`/styles.css`，只保留确有用途的公共资源。完成后应验证上述两个路径为 404，且 `/`、`/admin/tasks`、`/admin/feishu` 仍正常。

## T4：构建与测试（通过）

在正式目录运行：

```powershell
npm run build
npm test
```

结果：

- `npm run build` 成功，产物为 `dist/assets/index-CYOx_sWf.css`、`dist/assets/index-e1tcab0P.js`。
- `npm test`：56/56 通过，0 failed。

## 飞书一致性核验（部分通过）

- 评级优先级代码与单测已通过：`manual > legacy_reference > auto`。
- 当前 API 读取到评级来源：`legacy_reference=437`、`auto=113`、`manual=1`。
- 同步和 S/A 通知发送逻辑存在，且相关单测通过。
- **审计缺口**：`GET /api/admin/feishu` 当前 `notifications=[]`、`deliveries=[]`。因此无法从统一库验证“真实 S/A 提醒已投递”的历史记录。请 TraeWork 明确真实投递日志落点，或让 `notifier` 在真实发送成功后持久化 delivery（含事件 ID、消息 ID、状态、发送时间、失败原因）。

## 本轮改动

无业务代码改动。

本文件为验收交付物；仅新增该接续文档。

## 后续阻断项

在讨论迁移切换前，建议按优先级完成：

1. 移除 64504 对旧 `public/app.js`、`public/styles.css` 的直接服务能力。
2. 给 S/A 真实发送增加可查询的投递审计记录。
3. 保持旧 `GameNews` 双跑，继续完成旧简讯 URL 12/12 覆盖与 `西游大冒险` event 缺失修复。
