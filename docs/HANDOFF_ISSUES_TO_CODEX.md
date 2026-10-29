# HANDOFF — 待 Codex 解决的问题清单（TraeWork → Codex）

> 生成时间：2026-08-27
> 背景：前端收敛、静态隔离、投递审计、部分失败聚合均已验收通过。当前唯一正式项目目录 = `E:\新建文件夹\Codex-GPT\GameNewsUnified`。
> Codex 完成后按「四、回传要求」输出接续文档给 TraeWork。

---

## 一、当前状态（已验收，勿重复）

- React/Vite 为唯一前端，管理后台 6 面板（总览/来源采集/游戏管理/飞书同步/定时任务/运行日志）
- monitor 子来源聚合：`/api/admin/tasks` 返回 6 来源状态，全部成功=ok / 任一失败=partial（已真实失败验证，截图 `docs/screenshots/admin-tasks-partial.png`）
- 静态隔离：api-server 仅服务 dist/，`/app.js`、`/styles.css` 404（已删除 dist 遗留静态）
- 飞书 S/A 投递记录：sync.mjs 发送后写 `notifications`/`deliveries`（真实投递验证，截图 `admin-feishu-audit.png`）
- 测试：**56/56 全绿**；构建成功
- 迁移双跑同日对比完成：统一覆盖旧项目简讯 10/12，2 个缺失条目待决策

---

## 二、核心问题（P0，最紧急）：服务不常驻

**现状（已核实）**：
- `node` 进程列表**没有** api-server 与 scheduler
- 端口 `64504` 无监听（`curl http://127.0.0.1:64504/` 返回 000）
- 端口 `64500` 是旧实例（TraeWork/旧项目，非正式）

**影响**：
1. 网站 + API 当前**不可访问**（正式端口 64504）
2. **定时任务全部停摆**：每小时采集/飞书同步/S/A 提醒、每日 09:30 简讯海报、周一 09:00 周报均不执行

**请 Codex 完成**：
- 搭建**常驻运行方案**（pm2 / nssm / Windows 计划任务 三选一，推荐开机自启 + 日志落盘）
- 同时常驻两个进程：
  - `api-server`（正式端口 `64504`）：`GN_PORT=64504 node server/api-server.mjs`
  - `scheduler` 守护：`node server/tasks/scheduler.mjs`（默认加载 .env.local）
- 提供：启动命令、自启方式、日志位置、重启验证（`curl 64504/api/health` 与 monitor 下一轮执行）

---

## 三、其余问题（P1-P5）

### P1 海报外链公网（飞书群需能访问）
- `POSTER_BASE_URL` 已配置，但**确认当前值是否为公网地址**（Cloudflare Tunnel）
- 若仍是本机地址（127.0.0.1:*），飞书群里的海报链接无法打开
- 请配置公网 Tunnel 并将 `POSTER_BASE_URL` 指向公网地址；PNG 渲染仍走本机 HTTP

### P2 迁移切换决策
- 双跑同日对比完成：统一覆盖旧 GameNews 简讯 10/12
- 2 个缺失条目：`星球大战：银河赛车手`、`Trees Hate Y`（疑似旧项目独有端游/Steam 资讯源未覆盖）
- 请决策：是否停止旧 GameNews 双跑、统一项目全权接管；若需补源说明依据

### P3 副本一致性核对
- 正式目录 Codex-GPT；TraeWork 后续改动已同步：`api-server.mjs`（静态隔离）、`feishu/sync.mjs`（投递记录）、`crawler/run.mjs`（roundStartedAt）
- 请做一次**全量核对**：Codex-GPT 与 TraeWork 的 `server/`、`schema.sql`、`tests/` 是否一致，差异列明

### P4 前端移动端 390px 验收
- 用户核心需求：**390px 无横向溢出**（React 前端）
- 请在 64504 验证首页/管理后台 390px 视口无横向滚动，必要时补 CSS

### P5 其他确认
- `.env.local`：`FEISHU_POSTER_APP_ID` 当前**未配置**（海报机器人）——请确认是否需要补
- `FEISHU_TOPIC_NOTIFICATIONS_PAUSED` 未配置（=通知默认开，S/A 提醒生效）——确认符合预期
- `crawl_runs` 最近一轮是 partial（测试遗留，下次 monitor 正常后覆盖）——无需处理
- 飞书 batch_delete 需用 **POST**（DELETE+body 报 RecordIdNotFound）——若需删除接口，按 POST 封装

---

## 四、回传要求（Codex 完成后输出给 TraeWork）

1. **常驻方案**：选择的方式、启动命令、自启配置、日志位置、重启后验证结果（api 健康 + monitor 一轮执行）
2. **海报公网**：POSTER_BASE_URL 最终值（是否为 Tunnel 公网地址）、验证飞书海报链接可访问
3. **迁移切换**：是否停旧任务的决定与理由
4. **副本一致性**：核对结果 + 未同步文件清单
5. **390px 验证**：结果或 CSS 改动
6. 改动文件清单与原因

---

## 关键路径备忘
- 正式目录：`E:\新建文件夹\Codex-GPT\GameNewsUnified`
- 前端：`src/App.jsx`、`src/main.jsx`、`src/unified.css`；构建产物 `dist/`
- 后端：`server/api-server.mjs`、`server/tasks/scheduler.mjs`、`server/tasks/config.mjs`、`server/feishu/*`
- 测试：`tests/`（56 项）；截图：`docs/screenshots/`
- 配置：`.env.local`（**勿读取/打印/覆盖**）
