# 交接：恢复旧海报视觉 + hykb 分类/清洗修复（TraeWork 副本，供 Codex 审核）

> 依据：用户指令"仅在副本内工作，对照 dailyPoster.js/weeklyPoster.js 恢复原有视觉（只做字段适配，不重新设计），同步修复 hykb 二次分类与游戏名清洗"
> 日期：2026-08-31
> 执行边界：**只在副本** `E:\新建文件夹\TraeWork\6a8e97b0c36a13e47a2f964a\GameNewsUnified` 内修改；未改正式项目/数据库/输出/密钥/飞书/定时任务/正式服务；**未自行同步生产**。

## 一、改动清单（绝对路径 + 目的）

### 新增（从旧 GameNews 原样复制 + 字段适配）
| 路径 | 说明 |
|---|---|
| `...\GameNewsUnified\server\tasks\dailyPoster.js` | 旧日海报视觉原样移植（masthead/分区/卡片/事件双栏/CSS/JS 全保留）；仅 `remoteImage` 改为直连远程图（统一库无 /api/image-proxy，属字段适配） |
| `...\GameNewsUnified\server\tasks\weeklyPoster.js` | 旧周报视觉原样移植（14 天时间树）；移除 weeklySnapshots 依赖（落盘由统一 pipeline 接管）；图片直连；好游清洗改从 hykb.mjs 导入 |

### 修改
| 路径 | 目的 |
|---|---|
| `...\server\tasks\pipeline.mjs` | generateDaily/generateWeekly 改用移植的原始海报构建器；新增 `adaptUnifiedArticle(s)`（统一库行→旧海报数据形状：解析 facts/paragraphs/images、丢弃 /crawler-assets/ 本地图、补 __snapshotDate）；**移除此前"重设计"的自定义海报** |
| `...\server\crawler\hykb.mjs` | 游戏名清洗：extractGameName 的"-XX手游"副标题规则对齐旧版；新增 cleanDetailTitle/cleanUpdateTitle；新增新游/活动二次分类 `classifyHykbCategory`（镜像统一口径，活动侧拦截新游词）；fetchHykbItems 应用二次分类并补 `facts.haoyouUpdateContent`/`facts.haoyouCategory` |
| `...\server\feishu\algorithm.mjs` | 配套修复：eventType 将"活动信号"判断移到 `haoyouKind→新游` 之前，使 hykb 二次分类的 category/updateContent 生效（即将上线面板的周年/版本活动不再误入新游） |
| `...\server\feishu\poster.mjs` | 校验 DOM 兼容 `weekly-card`/`weekly-section`（周报四层校验通过） |
| `...\tests\poster.test.mjs` | 重写：端口/PNG 错误页判定 + adaptUnifiedArticle + 移植的 dailyPoster/weeklyPoster 渲染 |
| `...\tests\hykb-classify.test.mjs` | 新增：二次分类（新游/活动）+ extractGameName/cleanUpdateTitle + eventType 联动 |

## 二、测试

`npm test`（副本）→ **78/78 通过（38 suites）**。新增/重写用例：
- hykb 二次分类：update 面板出现纯新游生命周期→新游；upcoming/test 面板出现周年/版本等活动信号→活动；真首发/测试保持新游。
- hykb 游戏名清洗：`雾海之下-火车山谷2手游`→`雾海之下`、`-‘吃’打撤新游(官服)`、`-S3赛季`、`-4.4版本`、`-新版本预约`；cleanUpdateTitle 去前置游戏名/日期。
- eventType 联动：hykb 二次分类后周年版本→活动、首发→新游（既有 feishu/taptap-topic 测试全保留）。
- 海报：字段适配、移植的日/周海报渲染分区。

## 三、HTML/PNG 截图证据（副本 `output\poster-evidence\`）

| 产物 | 结果 |
|---|---|
| `简讯海报-2026-08-27.html`（142KB，86 条：新游35/Steam8/活动17/端游资讯26） | 日海报（旧原始视觉） |
| `简讯海报-2026-08-27.png`（4.26MB，1100×12000） | 四层校验 **ok:true** |
| `简讯海报-2026-08-27.top.png`（692KB） | 顶部截图，已核验为**旧原始样式**：masthead + 手机游戏·即将上线 / 版本更新·活动·联动 / Steam / 端游资讯 + TapTap/好游快爆事件双栏 |
| `游戏资讯周报-2026-08-27.html`（123KB，200 条） | 周报（含 14 天时间树） |
| `游戏资讯周报-2026-08-27.png`（2.99MB） | 四层校验 **ok:true** |
| `validation-2026-08-27.json` | 校验日志 |
| `blocked-demo.json` + `bad-error.png` | 错误页阻断实证：不存在路径→HTTP 404→ok:false→阻断发送 |

复现命令（副本工作区根目录）：
```powershell
node poster-evidence.mjs --date 2026-08-27 --port 64510 --limit 200   # 生成日/周 HTML+PNG+校验
node poster-blocked-evidence.mjs                                       # 顶部截图 + 错误页阻断
```

## 四、边界与回退

- 未改正式目录/正式库/副本库（证据只读打开）、未发飞书、未启动持久服务（临时 HTTP 64510 脚本内 try/finally 即停）、未动旧 GameNews、未改 config.mjs/scheduler.mjs 任务时间/发送对象/启停。
- **回退**：正式目录无任何改动，无需回退；副本如需放弃——删除 `server\tasks\dailyPoster.js`、`server\tasks\weeklyPoster.js`、`tests\hykb-classify.test.mjs`，还原 `pipeline.mjs`/`hykb.mjs`/`algorithm.mjs`/`poster.mjs`/`poster.test.mjs` 即可（既有 67 测试仍通过）。
- **未自行同步生产**；等待 Codex 审核后决定是否接收。

## 五、待 Codex 复核

1. 图片直连：统一库无 /api/image-proxy，海报图片直连远程 URL（字段适配）；如正式环境需代理可补端点。
2. hykb 二次分类为代码级修复（副本边界未重跑采集）；真实数据生效需下次采集落库后，或用正式库 dry-run 校验。
3. 周报未移植旧版 weeklySnapshots 快照读取，统一 pipeline 直接以 articles 表 14 天数据渲染（视觉一致，数据源不同）。
4. 恢复的日海报内部仍有"热榜话题"分区（旧样式自带），统一库若无可渲染内容则该分区留空。
