# GameNews 项目介绍与运行规则

> 更新日期：2026-09-23  
> 正式项目目录：`E:\新建文件夹\Codex-GPT\GameNews`  
> 用途：供新接手人员、开发人员和运维人员快速了解项目，不包含任何飞书密钥或敏感配置值。

---

## 1. 项目是什么

GameNews 是一个面向**手游分发和游戏内容运营**的本地资讯工作台，负责：

1. 从 TapTap、好游快爆、小七、Steam、游民星空、机核采集游戏资讯。
2. 区分新游、上线、测试、版本更新、活动、联动和普通资讯。
3. 清洗游戏名、正文、时间、标签、厂商、评论量或预约量。
4. 对内容去重、评分，并结合飞书中的人工游戏评级进行筛选。
5. 生成今日简讯、日报海报和周报海报。
6. 将新游、活动和评级同步到飞书多维表格。
7. 通过两个飞书机器人分别发送海报和新游/活动提醒。
8. 将正式日报、周报归档到私有 GitHub，方便跨电脑恢复。

项目不是通用爬虫，也不负责游戏商店上架、账号操作或自动发布游戏。

---

## 2. 技术架构

| 模块 | 技术/位置 |
|---|---|
| 前端 | React 19 + Vite 8，源码位于 `src/` |
| 后端 | Node.js ESM + Express 5，入口为 `server/index.js` |
| 数据库 | SQLite：`data/game-news-hub.sqlite` |
| 定时调度 | `node-cron`，核心文件 `server/scheduler.js` |
| Windows 守护 | Windows 计划任务 + 本地守护脚本 |
| 页面解析 | Cheerio、Firecrawl SDK、来源专用采集器 |
| 日报海报 | `server/dailyPoster.js` |
| 周报素材 | `server/weeklySnapshots.js` |
| 飞书同步 | `server/feishuTopicMonitor.js` |
| 飞书提醒 | `server/feishuTopicNotifier.js` |
| 海报投递 | `scripts/scheduled-posters.mjs` |
| GitHub 海报归档 | `scripts/publish-github-posters.ps1` |

### 整体流程

```text
采集来源
  ↓
来源适配器
  ↓
清洗、分类、时间解析、游戏名识别
  ↓
URL 去重 + 游戏名/标题去重
  ↓
自动评分和质量过滤
  ↓
SQLite articles
  ├─→ RAW 原始候选集
  ├─→ 今日简讯前端
  ├─→ 早报/晚报
  ├─→ 日报/周报海报
  └─→ 飞书游戏库
          ↓
      人工评级回写
          ↓
      新增 S/A 机器人提醒
```

---

## 3. 启动方式与网址

### 常用命令

在以下目录执行：

```powershell
cd E:\新建文件夹\Codex-GPT\GameNews
```

| 操作 | 命令 |
|---|---|
| 综合启动 | `npm start` |
| 开发模式 | `npm run dev` |
| 仅前端开发 | `npm run dev:client` |
| 仅后端开发 | `npm run dev:server` |
| 构建前端 | `npm run build` |
| 爬虫回归测试 | `npm run check:crawler` |

### 服务地址

| 页面/服务 | 地址 |
|---|---|
| 前端首页 | `http://127.0.0.1:64424/` |
| 今日简讯后台 | `http://127.0.0.1:64424/#/dash` |
| 后端健康检查 | `http://127.0.0.1:64424/api/health` |
| 前端热更新（可选，仅开发时） | `http://127.0.0.1:64423/`（需 `GAMENEWS_DEV_CLIENT=1`） |
| 海报公开服务健康检查 | `http://127.0.0.1:64425/health`（对外暴露面，禁止并入 64424） |
| 两者都由守护进程托管 | `scripts/gamenews-watchdog.ps1` 同时守 64424 与 64425；64425 挂了分享链接就白图，不能只守一个 |

RAW 历史页面：

```text
E:\新建文件夹\WorkBuddy\2026-07-30-11-37-18\output\RAW_ARTICLES.html
```

---

## 4. 前端说明

前端主要用于浏览、筛选和编辑今日资讯，不直接承担爬虫任务。

### 前端主要功能

- 今日简讯 Dashboard。
- 原始候选内容查看。
- 文章筛选和人工选择。
- 来源、栏目、正文和图片预览。
- 简讯生成结果查看。
- 日报海报内容核对。

### 今日简讯栏目

1. 手机游戏 · 即将上线
2. 手机游戏 · 今日更新
3. 版本更新 / 活动 / 联动 · 未来
4. TapTap 热榜话题
5. Steam · 新游上线
6. Steam · 热门 / 新上榜
7. 机核 / 游民星空

### RAW 和 Dashboard 的区别

- RAW：保留较宽的原始候选集，便于检查爬虫有没有漏抓。
- Dashboard：经过分类、去重、评分和业务筛选后的运营内容。
- 两者数量不要求完全相同。

### 修改前端时的规则

1. 不同时修改爬虫、数据库和飞书逻辑。
2. 修改 UI 后至少执行 `npm run build`。
3. 检查桌面端和 390px 移动端是否横向溢出。
4. 日报海报模板与网站前端是不同模块，不要混改。
5. 已确认的日报/周报样式不得在未确认时重新设计。

---

## 5. 当前采集来源

| 来源 | 主要内容 | 业务分流 |
|---|---|---|
| TapTap | 新游日历、即将上线、新品榜、新版本、热榜话题 | 新游、活动、热榜 |
| 好游快爆 | 即将上线、即将测试、即将更新、游戏详情 | 上线/测试为新游，更新为活动 |
| 小七 | 新游预约、折扣、预约量 | 仅新游 |
| Steam | 新品和商店 API | Steam 新游、榜单 |
| 游民星空 | PC/端游资讯 | 资讯栏目 |
| 机核 | 游戏编辑资讯 | 资讯栏目 |

### 重要分类规则

- 新游：首发、上线、公测、测试、预下载等生命周期事件。
- 活动：版本更新、联动、周年、赛季、角色、装备、副本等事件。
- 普通资讯：游民星空、机核等编辑资讯，不能混入新游/活动飞书表。
- 好游快爆时间线中“即将上线、即将测试”属于新游，“即将更新”属于活动。
- 好游快爆更新动态只读取最新第一条，后续列表属于历史记录。

---

## 6. 清洗、去重和评级

### 游戏名清洗

- 去掉预约、预下载、TapTap 测试版等无意义平台后缀。
- 游戏别名可以关联到标准游戏名。
- 体验服、测试服、国际服等正式版本区别原则上应单独保留。
- 不能将《明日方舟》和《明日方舟：终末地》等不同游戏合并。
- 不能将《少年三国志》和《少年三国志2》等续作合并。

> 当前 `server/crawler/deduper.js` 仍可能移除“测试服”后缀，这是待修复规则，修改时必须补回归测试。

### 去重

- 先按原文 URL 去重。
- 再按标准游戏名、标题和内容指纹去重。
- 跨平台相同新游优先使用 TapTap。
- 跨平台相同活动优先使用好游快爆。
- 体验服和正式服不应因为名称相近而去重。

### 自动分数

自动分数主要用于资讯排序，不等同于飞书中的最终人工评级。

主要加分项：

- 有明确的新游、上线、测试、版本或活动信号。
- 有明确日期和官方信息。
- TapTap 新品榜、热榜排名靠前。
- 游戏具有高热度 IP 或知名厂商背书。
- 评论量、关注量或预约量较高。

主要扣分项：

- 论坛帖、抽奖、合集、泛排行等低业务价值内容。
- 信息过少、标题无法识别游戏、疑似广告或低质量页面。
- 独立小项目且无热度、无厂商背书、无有效数据。

### 人工评级

- 游戏首次出现时可由系统自动评级。
- 人工可在飞书“游戏评级”表修改。
- 下一轮同步先读取人工评级，再更新新游/活动记录。
- 人工评级优先于自动评级。
- 新游/活动机器人只发送新增 S/A，B/C 不发送。

---

## 7. 飞书文档工作流

### 表格职责

- 数据表：保存新游和活动事件。
- 新游视图：筛选 `类型=新游`。
- 活动视图：筛选 `类型=活动`。
- 汇总视图：汇总全部内容，可显示较低评级。
- 游戏评级表：保存标准游戏名、标签、厂商、平台、人工评级等。

### 同步顺序

```text
读取飞书游戏评级表
  ↓
识别人工评级变化
  ↓
更新本地评级优先级
  ↓
采集并生成新游/活动事件
  ↓
增量写入飞书主数据表
  ↓
只筛选本轮新增 S/A
  ↓
发送新游/活动机器人消息
```

### 数据写入原则

- 只增量新增或补全缺失字段。
- 不主动删除历史记录。
- 不重建整张表。
- 不物理重排已有记录。
- 默认使用飞书视图本身的排序规则。
- 人工评级不应被自动评级覆盖。
- 飞书通知失败不回滚已经成功写入的数据。

### 飞书运行变量

项目只应在 `.env.example` 中记录变量名，真实值不得进入 GitHub：

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

---

## 8. 飞书机器人

项目使用两类机器人，职责必须分开。

### 海报机器人

发送：

- 每日简讯海报。
- 每周周报海报。

规则：

- 日报和周报分别做同日幂等，成功发送后当天不重复推送。
- 周报需要公开可访问的只读 HTML 和主图资源。
- 海报发送失败需要写入运行日志，不能假装发送成功。

### 新游/活动提醒机器人

发送：

- 新增 S/A 新游提醒。
- 新增 S/A 活动提醒。

格式：

- 新游：红色卡片。
- 活动：橙色卡片。
- 新游和活动分两条消息。
- 活动可展示首图。
- 单条消息最多展示 8 项，多余内容提示查看飞书表。
- 好游快爆活动内容可按 `，`、`；`、`!` 等符号换行。
- B/C 只进入飞书，不发送提醒。

---

## 9. 定时任务

### Node 定时任务

| 时间 | 任务 |
|---|---|
| 每日 08:00–23:00 整点 | 手游监控、飞书增量同步、新增提醒 |
| 每日 08:30 | 生成早报、日报海报并发送海报机器人 |
| 每日 17:50 | 生成晚报 |
| 每周一 08:35 | 生成周报并发送海报机器人 |
| 每日 03:15 | 数据留档和缓存清理 |

### Windows 计划任务

| 任务 | 用途 |
|---|---|
| `Komo-GameNews-Watchdog` | 每分钟一次健康检查（脚本无参数＝检查一次即退），自动拉起 64424 / 64425 |
| `Komo-GameNews-GitHub-PosterSync` | 每日 09:00 同步正式日报/周报到公开 GitHub |

### 调度注意事项

- scheduler 必须只有一个实例注册定时任务。
- 多个服务实例同时运行会导致重复抓取、重复推送或 SQLite 锁。
- 当前工作区已开发 scheduler 租约和海报投递幂等，但尚需测试并正式提交。
- 检查日志：`data/logs/cron-result.json`。
- 改计划任务时：`Register-ScheduledTask`（覆盖定义）实测会被拒 `Access denied`，
  需要管理员；改**已有**任务的触发器与设置用 `Set-ScheduledTask` 即可成功，
  `Start-ScheduledTask` / `Stop-ScheduledTask` 普通权限也可用。
- 排查常驻守护进程时注意：用 `CommandLine -like "*xxx*"` 过滤 PowerShell 进程
  会**匹配到执行这条查询的自身**，必须加 `-ne $PID`，否则会误判"守护在跑"
  甚至把自己杀掉。

---

## 10. 日报和周报海报

### 日报

- 数据来自当天 Dashboard/简讯投影。
- 主要展示图片、标题和部分摘要。
- 不需要“查看详情”等操作按钮。
- 样式由 `server/dailyPoster.js` 生成。
- 用户提供新的 HTML 模板后，应先生成预览，确认后再替换正式生成逻辑。

### 日报当前版式（2026-09-23 已确认）

| 栏目 | 栅格 | 说明 |
|---|---|---|
| 手机游戏 · 即将上线 | 一行 5 个 | 70px 方形图标 + 游戏名（2 行内）+ 日程（2 行内），卡片高 98px |
| 版本更新 / 活动 / 联动 | 2 列，按内容分块 | 分「版本更新 / 活动 / 联动 / 折扣 · 促销」四块，游戏名 17px |
| 热榜话题 | 单列排行榜 | 01–05 序号（前三 coral）+ 84px 封面 + 游戏名 / 话题 / 摘要 |

活动卡标题的换行是**在生成端按标点预排**的（`packTitleLines`，贪心装箱，每行 ≤38 格），
因此断点确定落在「，」「；」处；不要改回只依赖 CSS —— `word-break:keep-all`
并不能阻止 Chrome 在「」这类括号边界断行，会出现半句悬挂。
榜单页按 `scripts/preview-daily-poster.mjs` 离线预览，不依赖后端进程。

#### 日报长图裁边链路（2026-09-28 定位并修复，勿回退）

飞书卡片里的日报长图**必须裁掉底部空白画布**，否则整张图会变成「上方一小条内容 + 下方大片空白」。

| 环节 | 实测数据 |
|---|---|
| 渲染画布 | `--window-size=1100,12000`（`renderPosterPreview`，12000px 是为了不截断长日报） |
| 09-28 实际内容 | 末内容行 y=2128，裁后 **2201px**，被裁掉 **9799px**（占画布 82%） |
| 09-24/25/26 产物 | 全部是原始 **1100x12000**，即裁边完全没生效 |

根因：裁边原本靠 `execFileSync(process.env.PYTHON_BIN || "python", ["scripts/trim-poster-preview.py", ...])`，
而本机 PATH 上的 `python` 是**没装 PIL** 的托管解释器 ⇒ 每次都抛 `ModuleNotFoundError`；
调用处是 `try/catch + console.warn`，错误被吞掉 ⇒ 静默失效。

三条硬约束：

1. **裁边必须是零依赖的 Node 实现**：`scripts/trim-poster-preview.mjs`
   （`node:zlib` 解 PNG 像素 → 从底部找最后一行内容 → 裁到 `lastContent + 73`）。
   不要再依赖 `python` / PIL / PATH 上的任何外部解释器。
2. **裁边失败必须能看见**：`trimPosterPreview()` 会打印真实原因，并在「画布仍是 12000px 且高度没变小」时
   打 `裁边未生效` 警告。成功时打印 `PNG 裁边 1100x12000 → 1100x2201（去掉 9799px 空白）`。
3. **`scripts/trim-poster-preview.py` 已停用**（文件头有标注，仅作算法参照）。
   两种实现的输出已实测**逐像素一致**（像素 md5 相同），可安全互换。

验证方式（离线、不投递）：

```bash
# 1) 渲染一张复现用画布（会得到 1100x12000）
#    同 renderPosterPreview 的参数，指向 /generated-output/scheduled-posters/<name>.html
# 2) 跑裁边并看输出
node scripts/trim-poster-preview.mjs <png> --report   # 只报告不改
node scripts/trim-poster-preview.mjs <png>            # 就地裁边（幂等）
```

### 周报

- 使用周报快照，避免活跃文章清理后周报内容失效。
- 每篇只长期缓存一张主图，不缓存全部正文图片。
- 完整周报快照目标保留 30 天。
- 30 天后可只保留轻量 JSON。

#### 周报图片链路（2026-09-28 定位并修复，勿回退）

源站图片**按 Referer 防盗链**，同一份 HTML 在本地能看、经隧道分享出去就白图：

| 图片域名 | 不带 Referer | 带站外 Referer |
|---|---|---|
| `img.71acg.net`（好游快爆） | 200 | 200 |
| `f1.3839img.com`（九游） | 200 | 200 |
| `img-tc.tapimg.com`（TapTap） | 200 | **567** |
| `image.gcores.com`（机核） | 200 | **403** |
| `imgs.gamersky.com`（游民星空） | 200 | **403** |

因此有三条硬约束：

1. **主图必须落盘并由同源 `/assets/` 提供**。`server/weeklySnapshots.js`
   把每篇主图写到 `data/weekly-snapshots/<date>/assets/main-<sha1前16位>.<ext>`，
   快照里记为 `localUrl = /weekly-assets/<date>/assets/...`。
   `server/retention.js` 的归一化**必须带 `preserveLocal: true`**
   （RAW 留档路径保持默认 `false`，把本地引用还原成远程）。
   曾经漏了这一步：113 张图躺在磁盘上没人引用，周报只能回退远程地址 ⇒ 公开链接整片白图。
2. **抓图时不能统一发第三方 Referer**。`copyPrimaryImage` 早期固定发
   `https://www.3839.com/`，直接把 TapTap / 机核 / 游民的主图打到 403/567，
   只有 113/130 张落盘。现按图片域名给对应站点 Referer，失败再退回不带 Referer。
3. **公开只读服务必须代取，不能把原始地址甩给访问者**。
   `scripts/poster-public-server.mjs`（64425）在响应时改写 HTML：
   - `http://127.0.0.1:*/weekly-assets/...` → `/assets/...`（本地副本，同源）
   - `http://127.0.0.1:*/api/image-proxy?url=X` → `/image?url=X`（服务端代取，不带 Referer）

   **不能保留原始远程地址** —— 访问者浏览器直连源站会带隧道域名做 Referer，被 403/567 拦掉。

历史快照若已被抹掉 `localUrl`，用 `scripts/repair-weekly-snapshot-assets.mjs`
按 sha1 文件名确定性地挂回（无需重新抓取）；先 `--dry-run` 看清单。

`server/weeklyPoster.js` 的 `imageFor` / `iconFor` 都**优先取快照本地图**
（新游卡走 `iconFor`，早期只读 `article.image_url`，等于绕开了本地副本）。

### 正式输出目录

```text
E:\新建文件夹\Codex-GPT\GameNews\output\scheduled-posters
E:\新建文件夹\Codex-GPT\GameNews\published-posters\daily
E:\新建文件夹\Codex-GPT\GameNews\published-posters\weekly
```

---

## 11. 缓存和数据留档

| 数据 | 保留规则 |
|---|---|
| 活跃文章 | 最近 7 天和未来完整保留 |
| RAW 完整快照 | 7 天 |
| 周报完整快照和主图 | 30 天 |
| 过期资料 | 转为轻量 JSON 长期留档 |
| 图片 | 周报每篇主图落盘并由 `/assets/` 提供；无本地副本的走公开服务 `/image` 代取（源站有 Referer 防盗链，不能直链） |
| `.snapshots` | 当前约 1.29 GiB，尚需单独制定生命周期 |

删除任何历史快照前，必须先生成预览清单并由项目负责人确认。

---

## 12. GitHub 备份

公开仓库：

```text
https://github.com/A13612812330/GameNews
```

归档规则：

- 正式日报放入 `published-posters/daily/`。
- 正式周报放入 `published-posters/weekly/`。
- 以 SHA256 判断文件是否变化。
- 没有变化时不生成空提交。
- 不上传 `.env`、密钥、数据库、缓存、日志、备份或本地运行状态。

目前自动归档直接推送 `main`，后续建议补充失败告警和推送结果审计。

---

## 13. 当前已知风险

### 2026-09-28 已修复

- **TapTap 整源静默失效**（`server/crawler/tasks.js`）。源站从 Next.js 迁到 Nuxt 后，
  页内接口地址改写成 `http:\u002F\u002Fwww.taptap.cn\u002Fwebapiv2\u002F...`，
  旧提取正则只认 `\/` 一种转义 ⇒ 5 个入口全部 0 条且 `error=null`。
  `calendar/v1/upcoming` 已废弃，「今日游戏」改走 `calendar/v1/event-list`
  （按天返回 `list_a/b/c`，强制 `day=<unix 秒>`）。修复后候选 0 → 91，48h 入库 78 条。
- **Watchdog 停摆与自愈**（`scripts/gamenews-watchdog.ps1`）。三层原因：
  ① 任务 `/SC ONLOGON` 只在登录时跑一次，常驻守护被杀后无人重启；
  ② 动作直连 `powershell.exe -File` 时，任务实例会以 `0xC000013A` 提前终止常驻进程；
  最终改为**一次性健康检查**（脚本无参数即检查一次后退出，任务每分钟调用）。
  ③ **登录触发器挂 `Repetition` 不生效**：它只在登录事件真发生后计时，重新注册任务
  不会补一次登录 ⇒ `NextRunTime` 为空、实测停摆。已换成**时间触发器（每天 00:00）
  + 每 1 分钟重复 / 3650 天 / 到期不停任务**。反证：两次杀 64424 → 15 秒 / 20 秒拉起。
- **`hashtags` 入口**：源站 `/forum/hot/hashtags` 已 302 到 `/forum`，旧选择器
  `hot-hashtag-item` 0 次出现；但 `HotHashtagItem` 资源仍在预加载、`/forum` 有
  `<div data-column-id="hashtags">` 列切换条（纯 JS 按钮），说明是改成了 tab、接口待定位。
  处理：`registry.js` 该条置 `enabled:false` + `disabledReason`，`tasks.js` 支持
  单条 URL 级 `enabled` 过滤。保留登记、暂不抓取，避免每轮 0 条误报。
- **「整源 0 条」告警已实现**：连续 3 轮「完成且 0 条且无 `error`」产出
  `SOURCE_SILENT_ZERO`（`data/crawler/zero-streak.json` → `/api/crawl/monitor` 的
  `alerts`，同时写 `⚠️` 事件与定时日志）。阈值依据实测：健康源从未连续 3 次为 0，
  TapTap 事故期连续 3~4 次。反证脚本 `scripts/verify-silent-source-alert.mjs`。
- **定时流水线接入监控**（`server/scheduler.js`）：定时跑现在也进监控历史，
  不再只有手动抓取可见。手动抓取占用监控时自动让位。
- **`database is locked` 加固**（`server/database.js`）：补 `PRAGMA busy_timeout = 10000`。
  此前只设 WAL、未设 timeout，默认 0 导致并发写立刻失败，
  `runtime-logs/local-services/GameNews-api.log` 里累计 **121 次**（164 轮里约 74%），
  失败点固定停在「Step 2/3 补全新增或变化详情」。**注意这只是缓解**，不能阻止同时写。
- **重复实例并发写库 → 单实例闸门**（`server/index.js`）。根因链：两套守护都会拉起
  `server/index.js`（端口同 64424），而旧启动顺序是 `seedBuiltinSources()`（写库）
  → `startScheduler()` → `app.listen()`，**写库发生在实例知道自己是重复实例之前**，
  于是抢不到端口的重复实例在退出前已经写过库。实测它打印了
  `[scheduler] 已有其他…持有调度锁`，却仍打开数据库、打印 API 地址、且不立即退出。
  修法：新增 `data/logs/instance.lock` 闸门，`fs.openSync(..., "wx")`（O_EXCL）原子创建，
  配 `process.kill(pid, 0)` 判活；死 pid 残留可接管（崩溃自恢复）、带 BOM 也能正确解析。
  闸门在 `seedBuiltinSources()` 之前 ⇒ 重复实例**零副作用退出**。
  另补 `app.listen` 的 `error` 处理：端口被其它程序占用时明确退出。
  判据为何不用端口/`listen` 回调：Windows `SO_REUSEADDR` 允许重复 `bind`，
  失败发生在 `listen` 阶段而 Node 已发出 `listening` 事件 —— 实测回调先执行、
  `EADDRINUSE` 后到达。反证脚本 `scripts/verify-single-instance-guard.mjs`
  （4 场景 15 条断言；反向验证：闸门判活改恒真后 6 条变红）。

### 待决策 / 未修

- ~~**64424 被两套守护同时负责**~~ → **风险已消除**（单实例闸门让重复实例零副作用退出）。
  **仍建议收敛（二选一）**，理由是排查成本：两者日志落在不同位置
  （本项目 `logs/` vs 工作区 `runtime-logs/local-services/`），且都会写
  `data/logs/cron-result.json` 互相覆盖，同一时刻能看到两种候选数。
  工作区守护属跨项目文件（`E:\新建文件夹\Codex-GPT\tools\local-services\`），改动需先确认。
- `published-posters/assets` 无保留窗口；`data/backups` 139M + `data/weekly-snapshots`
  113M 无上限。
- 抓取器在工作区守护的调用环境下可能撞到 `Path`/`PATH` 重复环境键，`Start-Process`
  报 `Item has already been added. Key in dictionary: 'Path'`；该失败只写进
  `logs/watchdog.log`，属同类「静默」，建议加降级启动路径并上报监控。

### P0

- ~~海报重复发送防护、周报图片路径修复、日报长图裁边改 Node 实现、scheduler 单实例锁仍有未提交修改。~~
  → 已提交并推送（远端 `main` = 本地 HEAD）。
- ~~日报海报连续投递失败~~ → 2026-09-28 修复（超时预算倒挂 / stdout 契约污染 /
  日报周报共用互斥标志），详见 `docs/GameNews-项目交接说明.md` 十四节。
  **注意：需重启生产实例才会生效。**
- 临时 Cloudflare 隧道地址可能失效，不能视为永久周报链接。
- **4 个 `cloudflared` 隧道同时运行**（全指向 `127.0.0.1:64425`，启动于 09-21 08:31~08:35），
  只应保留 1 个。

### P1

- `.snapshots` 约 1.29 GiB，缺少自动生命周期。
- ~~采集源「0 条」不告警~~ → 已实现连击告警；残余：尚未接入飞书机器人推送。
- **定时日志时间戳是 UTC**：日志里 `[monitor-hourly 09:00:00]` 实际是北京时间 17:00。
- `published-posters/assets` 无保留窗口，已随期数线性增长。
- 前端 64423 跑的是 vite dev server（非构建产物），改代码不重启不生效。
- 去重器处理“测试服”的规则与业务要求冲突。
- README 仍包含已停用来源。
- 缓存文档中同时存在 48 小时、7 天、30 天、90 天等旧口径。
- `server/dailyPoster.js` 的日报版式改版（活动区按内容分块、标点对齐换行、即将上线一行 5 个、热榜改排行榜）已经项目负责人逐版确认，但代码与产物均**未提交**，改动与稳定性修复混在同一工作区里。

### P2

- 自动化测试覆盖不完整。
- 飞书相关规则集中在较大的脚本中，维护成本较高。
- 根目录存在未审计的临时 JSON/TXT 文件。
- `node:sqlite` 仍属于实验性 Node API。

---

## 14. 新接手人员建议阅读顺序

1. `README.md`
2. `package.json`
3. `server/crawler/registry.js`
4. `server/scheduler.js`
5. `server/briefProjection.js`
6. `server/crawler/scorer.js`
7. `server/crawler/deduper.js`
8. `server/feishuTopicMonitor.js`
9. `server/feishuTopicNotifier.js`
10. `server/dailyPoster.js`
11. `server/weeklySnapshots.js`
12. `scripts/scheduled-posters.mjs`
13. `docs/audit/GameNews-项目全量审计-2026-09-23.md`

---

## 15. 修改项目时的最低验证要求

### 修改爬虫或清洗规则

```powershell
npm run check:crawler
```

至少补一个正样本和一个负样本，防止旧问题复现。

### 修改前端

```powershell
npm run build
```

同时检查桌面端和 390px 移动端。

### 修改后端或调度

检查：

```text
http://127.0.0.1:64424/api/health
```

并确认：

- 只有一个 scheduler。
- SQLite 没有持续锁。
- 没有重复飞书推送。
- `data/logs/cron-result.json` 写入正常。

### 修改日报/周报

- 先生成测试预览。
- 检查图片加载、文字截断、底部长留白。
- **日报长图必须核对裁边结果**：投递用的 PNG 高度应远小于渲染画布（正常约 2000–3000px）。
  若产物仍是 `1100x12000`，说明裁边链路断了，见「日报长图裁边链路」一节。
- 测试同日重复运行是否会再次推送。
- 周报需验证公开 HTML 和主图都能访问。

---

## 16. 交接原则

- 不读取或提交真实飞书密钥。
- 不直接清空数据库或飞书表。
- 不在没有预览时批量删除历史缓存。
- 不把视觉改版和稳定性修复混在同一个提交。
- 不停止旧服务或定时任务，除非项目负责人明确要求。
- 所有重要修改需要留下文件清单、测试结果、回退方法和 Git 记录。

---

## 17. 相关文档

| 文档 | 路径 |
|---|---|
| 全量审计 Markdown | `E:\新建文件夹\Codex-GPT\GameNews\docs\audit\GameNews-项目全量审计-2026-09-23.md` |
| 全量审计 HTML | `E:\新建文件夹\Codex-GPT\GameNews\docs\audit\GameNews-项目全量审计-2026-09-23.html` |
| 本项目介绍 | `E:\新建文件夹\Codex-GPT\GameNews\docs\GameNews-项目介绍与运行规则.md` |

