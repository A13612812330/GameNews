# GameNews 项目交接说明

> 交接日期：2026-09-23  
> 正式项目：`E:\新建文件夹\Codex-GPT\GameNews`  
> 私有仓库：`https://github.com/A13612812330/GameNews`  
> 建议新 Agent 首先阅读本文件，再阅读 `AGENTS.md` 和 `docs/GameNews-项目介绍与运行规则.md`。

## 一、交接目标

本项目准备转交给另一个 Agent 继续维护。接手目标是：

1. 保持现有 GameNews 服务、爬虫、飞书文档和机器人正常运行。
2. 在不污染现有数据与定时任务的前提下继续优化前端和日报海报。
3. 优先处理稳定性、规则一致性和未提交修改，避免重复推送、重复调度或历史数据丢失。
4. 所有改动需可验证、可回退，并和视觉改版分开提交。

## 二、项目定位

GameNews 是面向手游分发和游戏内容运营的本地资讯工作台，主要功能包括：

- 采集 TapTap、好游快爆、小七、Steam、游民星空和机核内容。
- 识别新游、测试、上线、版本更新、活动、联动和普通资讯。
- 清洗游戏名、日期、正文、标签、厂商、评论量或预约量。
- URL 去重、游戏名/标题去重、自动评分和人工评级回写。
- 生成今日简讯、日报海报和周报海报。
- 同步飞书游戏库。
- 使用独立机器人发送海报和新增 S/A 新游/活动提醒。
- 将正式日报、周报归档到私有 GitHub。

## 三、技术栈与目录

| 模块 | 技术/路径 |
|---|---|
| 前端 | React 19 + Vite 8，`src/` |
| 后端 | Node.js ESM + Express 5，`server/index.js` |
| 数据库 | SQLite，`data/game-news-hub.sqlite` |
| 调度 | `node-cron`，`server/scheduler.js` |
| 来源注册 | `server/crawler/registry.js` |
| 评分 | `server/crawler/scorer.js` |
| 去重 | `server/crawler/deduper.js` |
| 今日简讯投影 | `server/briefProjection.js` |
| 日报海报 | `server/dailyPoster.js` |
| 周报快照 | `server/weeklySnapshots.js` |
| 飞书同步 | `server/feishuTopicMonitor.js` |
| 飞书提醒 | `server/feishuTopicNotifier.js` |
| 海报投递 | `scripts/scheduled-posters.mjs` |
| GitHub 海报归档 | `scripts/publish-github-posters.ps1` |

## 四、服务入口

| 用途 | 地址/命令 |
|---|---|
| 综合启动 | `npm start` |
| 开发模式 | `npm run dev` |
| 前端 | `http://127.0.0.1:64423/` |
| 今日简讯 | `http://127.0.0.1:64423/#/dash` |
| 后端健康 | `http://127.0.0.1:64424/api/health` |
| 海报服务健康 | `http://127.0.0.1:64425/health` |
| 构建 | `npm run build` |
| 爬虫回归 | `npm run check:crawler` |

历史 RAW 页面：

```text
E:\新建文件夹\WorkBuddy\2026-07-30-11-37-18\output\RAW_ARTICLES.html
```

## 五、正式采集源与分流

| 来源 | 内容 | 分流 |
|---|---|---|
| TapTap | 日历、即将上线、新品榜、新版本、热榜 | 新游、活动、热榜 |
| 好游快爆 | 上线、测试、更新和详情 | 上线/测试为新游，更新为活动 |
| 小七 | 预约、折扣、预约量 | 仅新游 |
| Steam | 新品/API | Steam 新游、榜单 |
| 游民星空 | PC/端游资讯 | 普通资讯 |
| 机核 | 编辑资讯 | 普通资讯 |

九游、游侠网已从正式来源注册表移除。README 中仍有旧描述，待修正。

## 六、核心业务规则

### 分类

- 新游：首发、上线、公测、测试、预下载等生命周期事件。
- 活动：版本更新、联动、周年、赛季、角色、装备、副本等。
- 游民星空和机核内容统一进入资讯，不进入新游/活动飞书表。
- 好游快爆更新动态只取第一条；其余视为历史。

### 游戏名和去重

- URL 去重后，再按标准游戏名、标题和内容指纹去重。
- 跨平台相同新游优先 TapTap。
- 跨平台相同活动优先好游快爆。
- 体验服、测试服等正式版本区别应独立保留。
- 当前 `server/crawler/deduper.js` 仍会移除“测试服”，这是已知待修复项。

### 分数和评级

- `articles.score` 用于资讯排序，不等同于最终人工评级。
- 自动分数综合有效事件、时间、官方信息、平台热度、评论/预约量、厂商与重点 IP。
- 飞书“游戏评级”表中的人工评级优先。
- 每轮同步先回写人工评级，再同步新游/活动。
- 只有本轮新增 S/A 发送机器人提醒；B/C 只入库。

## 七、今日简讯与前端

栏目顺序：

1. 手机游戏 · 即将上线
2. 手机游戏 · 今日更新
3. 版本更新 / 活动 / 联动 · 未来
4. TapTap 热榜话题
5. Steam · 新游上线
6. Steam · 热门 / 新上榜
7. 机核 / 游民星空

RAW 是宽候选集，Dashboard 是业务投影，两者数量不必一致。

前端修改要求：

- API 请求复用 `src/services/api.js`。
- 不在组件中硬编码后端地址。
- 共用设计变量放 `src/design-system.css`。
- 修改后执行 `npm run build`。
- 检查桌面端和 390px 移动端。
- 网站前端和日报海报模板是两个模块，不要混改。

## 八、日报和周报海报

- 日报数据来自当天简讯投影。
- 日报只需要图片、标题和部分内容，不需要详情按钮。
- 周报使用独立快照，避免活跃数据清理后资源失效。
- 周报每篇只保存一张主图，完整快照目标保留 30 天。
- 正式产物位于 `output/scheduled-posters/`。
- GitHub 归档位于 `published-posters/daily/` 和 `published-posters/weekly/`。
- 用户后续会提供优化后的 HTML，用于继续优化日报海报；应先做测试预览，经确认后再更新正式生成器。

## 九、飞书文档与机器人

### 飞书数据流程

```text
游戏评级表 → 人工评级回写 → 新游/活动增量同步
                           → 本轮新增 S/A → 提醒机器人
```

规则：

- 不删除、不重建、不物理重排飞书历史数据。
- 只新增或补齐缺失字段。
- 使用飞书视图已有排序规则。
- 人工评级不被自动评级覆盖。
- 通知失败不回滚飞书表写入和本地采集。

### 两类机器人

1. 海报机器人：发送日报和周报。
2. 新游/活动机器人：新游红色、活动橙色，分消息发送，仅新增 S/A。

### 配置安全

真实值只保存在本机私有环境配置，不得读取、打印或提交。变量名参考 `.env.example`：

```text
FEISHU_POSTER_APP_ID
FEISHU_POSTER_APP_SECRET
FEISHU_POSTER_CHAT_ID
FEISHU_TOPIC_APP_ID
FEISHU_TOPIC_APP_SECRET
FEISHU_TOPIC_CHAT_ID
FEISHU_TOPIC_NOTIFICATIONS_PAUSED
FEISHU_MONITOR_APP_ID
FEISHU_MONITOR_APP_SECRET
FEISHU_MONITOR_APP_TOKEN
FEISHU_MONITOR_TABLE_ID
FEISHU_MONITOR_RATING_TABLE_ID
POSTER_PUBLIC_PORT
POSTER_PUBLIC_SERVER
EDGE_BIN
```

## 十、定时任务

| 时间 | 任务 |
|---|---|
| 每日 08:00–23:00 整点 | 手游监控、飞书增量同步、新增提醒 |
| 每日 08:30 | 早报、日报海报、海报机器人 |
| 每日 17:50 | 晚报 |
| 周一 08:35 | 周报、海报机器人 |
| 每日 03:15 | 留档和缓存清理 |
| 每日 09:00 | GitHub 正式海报归档 |

Windows 任务：

- `Komo-GameNews-Watchdog`：维持本地服务。
- `Komo-GameNews-GitHub-PosterSync`：同步正式海报。

注意：scheduler 只能有一个实例。历史曾出现 `database is locked`，当前工作区已有单实例租约修改，但尚未正式提交。

## 十一、缓存与保留

| 数据 | 目标规则 |
|---|---|
| 活跃文章 | 最近 7 天和未来完整保留 |
| RAW 完整快照 | 7 天 |
| 周报完整快照和主图 | 30 天 |
| 过期数据 | 轻量 JSON 长期留档 |
| 图片 | 优先保存远程 URL，周报仅缓存主图 |
| `.snapshots` | 当前约 1.29 GiB，尚无明确生命周期 |

旧文档仍存在 48 小时和 90 天口径，接手后需统一为现行规则。

## 十二、GitHub 与跨电脑恢复

- 仓库为私有仓库。
- 正式日报和周报每日 09:00 自动归档。
- SHA256 判断变化，无变化不空提交。
- 不上传 `.env`、数据库、缓存、日志、备份和本地运行状态。
- 新电脑需自行安装依赖，并根据 `.env.example` 配置本机私有值。

## 十三、当前工作区状态（非常重要）

截至 2026-09-23，本地存在尚未提交的业务修改：

```text
M scripts/poster-public-server.mjs
M scripts/retention-maintenance.mjs
M scripts/scheduled-posters.mjs
M server/crawlFinalize.js
M server/dailyPoster.js
M server/retention.js
M server/scheduler.js
M server/weeklySnapshots.js
```

主要包含：

- 海报同日防重复投递和跨进程锁。
- scheduler 单实例租约。
- 周报公开图片路径修复。
- 周报快照改为 30 天和每篇一张主图。
- `server/dailyPoster.js` 中未确认的活动区域视觉重构。

这些代码**未包含在本次交接文档提交中**。新 Agent 不得假设 GitHub 已经拥有这些修改，也不得直接覆盖本地工作区。

未追踪临时文件：

```text
gen-req.json
proj.json
selected-ids.txt
scripts/preview-daily-poster.mjs
```

来源和用途尚未全部审计，不能直接删除或提交。

## 十四、已知风险优先级

### P0

- 本地稳定性修复未提交，跨电脑仅拉 GitHub 会缺少这些改动。
- 临时 Cloudflare/trycloudflare 地址不是永久海报地址。

### P1

- `.snapshots` 约 1.29 GiB。
- Watchdog 最近任务结果非 0，但服务目前可用。
- 测试服归一与独立版本业务要求冲突。
- README 来源列表与正式 registry 不一致。
- 48 小时、7 天、30 天、90 天保留口径冲突。
- 日报活动区视觉改版尚未得到确认。

### P2

- 自动测试覆盖不完整。
- 飞书规则集中在较大脚本中。
- GitHub 自动归档直接 push main，缺少失败告警。
- `node:sqlite` 仍为实验性 API。

## 十五、接手后的建议顺序

1. 只读检查当前 Git 状态、服务和计划任务，不立即覆盖或清理。
2. 将稳定性修复与日报视觉改版拆开审查。
3. 对稳定性修复执行构建、爬虫回归、海报 dry-run 和幂等验证。
4. 单独生成日报新版预览，由用户确认后再更新正式模板。
5. 修复测试服独立规则并补正负回归样本。
6. 统一 README、OPERATING_RULES、源码注释中的来源与保留期。
7. 对 `.snapshots` 生成清理预览，等待用户确认后再删除。
8. 补 Watchdog、飞书投递和 GitHub 同步失败告警。

## 十六、最低验收要求

### 爬虫/清洗修改

```powershell
npm run check:crawler
```

至少增加一个正样本和一个负样本。

### 前端修改

```powershell
npm run build
```

检查桌面端和 390px 移动端。

### 后端/调度修改

- `http://127.0.0.1:64424/api/health` 正常。
- 只有一个 scheduler。
- 无持续 SQLite 锁。
- 无重复飞书投递。
- `data/logs/cron-result.json` 记录正确。

### 海报修改

- 先生成测试预览，不直接发机器人。
- 检查图片、文字溢出和底部长留白。
- 验证同日重复执行不会再次发送。
- 周报公开 HTML 和主图均可访问。

## 十七、接手必读文件

1. `AGENTS.md`
2. `docs/GameNews-项目交接说明.md`
3. `docs/GameNews-项目介绍与运行规则.md`
4. `docs/audit/GameNews-项目全量审计-2026-09-23.md`
5. `package.json`
6. `server/crawler/registry.js`
7. `server/scheduler.js`
8. `server/briefProjection.js`
9. `server/crawler/scorer.js`
10. `server/crawler/deduper.js`
11. `server/feishuTopicMonitor.js`
12. `server/feishuTopicNotifier.js`
13. `server/dailyPoster.js`
14. `server/weeklySnapshots.js`
15. `scripts/scheduled-posters.mjs`

## 十八、安全与操作边界

- 不读取、打印或提交真实密钥。
- 不直接清空 SQLite 或飞书表。
- 不在没有预览时删除历史缓存。
- 不扩大爬虫目标范围。
- 不把视觉改版和稳定性修复混成一次提交。
- 不在未确认时停止服务、计划任务或机器人。
- 每次重要修改需提供文件清单、测试结果、回退方式和 Git 记录。

