# HANDOFF — 前端收敛为 React/Vite 唯一实现（TraeWork → Codex）

> 生成时间：2026-08-27
> 目的：TraeWork 已完成前端收敛核心工作，剩余渲染验证与端口收敛因本机浏览器扩展问题暂停，交接给 Codex 完善。Codex 完成后按「第五部分」输出接续文档回传 TraeWork。

---

## 一、当前已完成的（无需重复）

### 1. 唯一正式项目目录
**`E:\新建文件夹\Codex-GPT\GameNewsUnified`**（React 前端、飞书 .env.local、运行库、scheduler 均在此）。
TraeWork 副本仅作后端开发工作区，正式运行只认 Codex-GPT。

### 2. React/Vite 前端 = 唯一实现（不再保留第二套静态前端）
- 源码：`src/App.jsx`（已改造）、`src/main.jsx`、`src/unified.css`
- 构建产物：`dist/`（`npm run build` 成功，index-e1tcab0P.js 256KB）
- 静态前端 `public/app.js + styles.css`：**保留但不启用**（api-server 优先 dist）

### 3. 前端信息架构（App.jsx 已实现）
- **资讯网站为主入口**：`/`（首页）、`/mobile`（新游与活动）、`/steam`（Steam 新游）
- **管理后台为独立入口**：`/admin/overview`，侧栏 6 面板（非并排两套导航）：
  `数据总览 / 来源采集 / 游戏管理 / 飞书同步 / 定时任务 / 运行日志`
- 顶部导航仅 4 项：资讯首页 / 新游与活动 / Steam 新游 / 管理后台

### 4. 运行台子来源状态聚合（核心验收点）
- 后端 `server/api-server.mjs` `adminTasks()`：monitor 按最近一轮（`run_kind='monitor' AND started_at=<本轮>`）聚合 6 子来源
  - `lastStatus`：全部 ok=成功 / 任一失败=partial / 全失败=failed
  - 返回 `sources[]`（source_id/status/error/items_found/items_new/finished_at）+ `lastError`（失败来源与错误摘要）
- `server/crawler/run.mjs` `runSources()`：本轮所有来源共享同一 `roundStartedAt`，保证按轮聚合
- 已验证：64504 `/api/admin/tasks` 的 monitor 返回 6 来源全 ok，`items_found` 各来源正确（gamersky16/gcores5/haoyou40/steam15/taptap0/x7 6）

### 5. 飞书面板
- 后端 `GET /api/admin/feishu`：notifications / deliveries / ratings 来源分布
- 已验证：`{"ratings":[{"source":"legacy_reference","c":409},{"source":"auto","c":107},{"source":"manual","c":1}]}`
- 前端 `FeishuPage`：指标卡 + 评级来源分布 + 最近通知列表

### 6. 构建与测试
- `npm run build` ✅（dist 就绪）
- `npm test` ✅ **56 项全绿**（tests/ 已同步含 feishu 相关；已补 `server/tasks/feishu-sync.mjs` 依赖）

### 7. 运行中的正式服务
- **端口 64504**：`GN_PORT=64504 node server/api-server.mjs`（Codex-GPT 库 + React dist + 新 API + .env.local）
- 已确认 `/` 返回 React（index-e1tcab0P.js）、`/api/admin/tasks` 新字段、`/api/admin/feishu` 正常
- 截图已生成：`docs/screenshots/{home,admin-tasks,admin-feishu}.png`（Edge headless，home 217KB 非白屏）

### 8. S/A 提醒
- 本轮 monitor 真实发送成功（新游"霓虹深渊2"，messageId 已返回）——提醒链路正常

---

## 二、Codex 需完善的后续任务

### T1. 页面渲染验证（原 browser_use 因浏览器扩展卡住，请用其他方式）
- 目的：确认 React 页面实际渲染（非 loading / 非白屏 / 非报错）
- 方式建议（任选）：
  - 人工打开 `http://127.0.0.1:64504/` 确认首页 hero、`/admin/tasks` 显示 6 子来源、`/admin/feishu` 显示评级分布
  - 或 curl `/` 确认返回 dist index.html；curl `/api/admin/tasks`、`/api/admin/feishu` 确认 JSON
- 参考截图：`docs/screenshots/home.png`、`admin-tasks.png`、`admin-feishu.png`（Edge headless 已截）

### T2. 端口收敛（正式端口统一）
- 当前 **64503** 是旧实例（`node server/api-server.mjs`，PID 23596，服务**旧静态前端**），未加载新代码/新 dist
- 正式 React 服务在 **64504**
- 请处理：停掉 64503 旧进程（PID 23596），确认无静态前端服务残留；正式端口建议统一为 **64504**
- 若需恢复 64503：用新代码重启 `GN_PORT=64503 node server/api-server.mjs`（服务 React dist）

### T3. 静态前端确认不启用
- `public/app.js + styles.css` 保留文件但不服务（api-server 优先 dist）——确认 T2 停旧进程后，静态实现不再对外

### T4. 验收交付物
- 正式运行目录、启动命令、运行端口、页面截图、`npm run build` / `npm test` 结果（大部分已就绪，补齐 T1 后汇总）

---

## 三、关键文件位置

| 用途 | 路径 |
|---|---|
| 正式目录 | `E:\新建文件夹\Codex-GPT\GameNewsUnified` |
| React 前端 | `src/App.jsx`、`src/main.jsx`、`src/unified.css` |
| 后端 API | `server/api-server.mjs`（adminTasks 子来源聚合、`/api/admin/feishu`） |
| 爬虫编排 | `server/crawler/run.mjs`（roundStartedAt 同轮聚合） |
| 飞书模块 | `server/feishu/*`（client/algorithm/rating-store/sync/notifier/poster） |
| 调度 | `server/tasks/scheduler.mjs`、`config.mjs`、`pipeline.mjs`、`feishu-sync.mjs` |
| 构建产物 | `dist/` |
| 测试 | `tests/`（56 项全绿） |
| 截图 | `docs/screenshots/` |
| 运行库 | `data/game-news-unified.sqlite` |
| 密钥配置 | `.env.local`（**勿读取/打印/覆盖**） |

---

## 四、注意与约束
- **勿读取、打印、提交 `.env.local` 密钥**
- 勿覆盖 `public/` 静态文件（保留不启用即可）
- 旧项目双跑继续：在 React 前端实际验证通过前不停止旧 GameNews 双跑
- 不做样式优化验收（用户明确：React 跑起来前不进样式优化验收）

---

## 五、Codex 完成后需输出给 TraeWork 的接续文档（必填）

请在完成 T1–T4 后，输出一份接续文档，包含：
1. **渲染验证结果**：`/`、`/admin/tasks`、`/admin/feishu` 三页实际渲染确认（截图或文字说明），若 monitor 有任一子来源失败，确认显示"部分失败"+失败来源/错误/重试时间
2. **端口收敛结果**：64503 旧静态进程是否已停、正式端口最终值、启动命令
3. **build/test 最终结果**：`npm run build` 与 `npm test` 输出
4. **一致性确认**：飞书同步（增量、评级分级 manual>legacy>auto）、monitor 子来源聚合、S/A 提醒链路
5. 如有代码改动，列明改动文件与原因

TraeWork 收到接续文档后继续推进后续阶段（迁移切换评估等）。
