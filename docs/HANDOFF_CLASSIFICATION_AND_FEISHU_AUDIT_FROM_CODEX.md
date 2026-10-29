# HANDOFF — 资讯分类隔离与飞书投递审计（Codex）

完成时间：2026-08-27

## 本轮完成

1. **端游资讯分类隔离**
   - `ref-gamersky`、`ref-gcores` 及资讯/新闻类文章不再进入飞书新游、活动事件。
   - React 首页将其展示为独立的“端游资讯”区块；“新游上线与测试”只显示新游、测试。
   - 新游与活动页面也排除资讯内容。

2. **飞书 S/A 提醒投递审计**
   - 提醒先写入 `notifications` 待发送队列，按事件 ID 防重。
   - 每次投递结果写入 `deliveries`：发送状态、飞书消息 ID、重试次数、失败原因、更新时间。
   - 失败采用退避重试；后台“加入重试”只重新排队，不会立即发送。
   - 自动评级不覆盖人工评级，且同一游戏未来的不同事件仍可正常提醒。

3. **日志收敛**
   - scheduler 普通日志只输出来源状态、发现/新增数量、飞书新增/更新/歧义/提醒统计。
   - 不再输出完整飞书同步对象、事件正文或飞书字段对象。
   - 注意：当前常驻 scheduler 是本轮改动前启动的进程，旧日志仍保留旧格式；为避免重启后立即再次采集并触发真实提醒，本轮未强制重启 scheduler。代码会在下一次受控重启后生效。

4. **旧静态入口隔离**
   - 正式服务继续只使用 React/Vite 的构建入口。
   - 即使旧 `dist/app.js`、`dist/styles.css` 遗留，正式服务也会返回 404，避免误进入旧页面。

## 数据库变更与备份

- 正式库：`data/game-news-unified.sqlite`
- 本轮备份：`backups/game-news-unified-before-feishu-audit-20260827-174447.sqlite`
- 仅补充审计兼容字段：
  - `notifications.retry_count`、`next_retry_at`、`updated_at`
  - `deliveries.message_id`、`retry_count`、`last_error`、`created_at`、`updated_at`
- SQLite `integrity_check`：`ok`
- 本轮未调用飞书发送接口，未创建测试通知，也未改动飞书 Base。

## 验证结果

- `npm test`：退出码 0。
- `node --test tests/feishu-sync.test.mjs`：5/5 通过。
  - 游民/机核资讯不会成为飞书新游/活动。
  - 内存库验证：通知入队、消息 ID 留存、失败重试状态正常。
- `npm run build`：退出码 0。
- 正式 API：`http://127.0.0.1:64504/api/health` 返回 `ok: true`。
- `/app.js`：404，旧静态入口已隔离。
- 浏览器验收：
  - 首页可见“端游资讯”，游民/机核文章未进入首页的新游区。
  - `/admin/feishu` 能展示通知、投递、评级来源与失败重试入口。
  - 首页、飞书页在 390px 宽度均无横向溢出；控制台无错误。

## 运行状态与边界

- 64504 API 与 scheduler 由 `scripts/run-unified-service.ps1` 守护；本轮仅重启 API 子进程加载代码，scheduler 与旧 `GameNews` 双跑没有停止。scheduler 日志摘要的运行时生效需一次受控重启。
- 未接入公网 Tunnel，`POSTER_BASE_URL` 未在本轮处理。
- 正式库中已有一条名称为“投递审计S”的演示型审计记录（通知 1、投递 1）；本轮没有新增、修改或删除它。如要清理，应先由用户确认。
