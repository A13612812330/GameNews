# 交接：海报优化修复（TraeWork 副本执行，供 Codex 审查）

> 依据：`storage-reports/GameNewsUnified-优化修复方案-2026-08-31.html`（P0/P1 海报相关）
> 执行边界：**只在 TraeWork 副本**（`e:\新建文件夹\TraeWork\6a8e97b0c36a13e47a2f964a\GameNewsUnified`）内修改；
> 未改正式目录、未写正式库/副本库、未发送飞书、未启动持久服务、未动旧 GameNews。
> 日期：2026-08-31（Asia/Shanghai）

## 一、改动清单（仅副本，绝对路径 + 目的）

| 文件 | 目的 |
|---|---|
| `...\GameNewsUnified\server\feishu\poster.mjs` | P0#1 端口统一 64504（`DEFAULT_POSTER_BASE_URL`，不再回退 64500）；P0#3 PNG 四层校验（HTTP/DOM/图片/PNG 特征），任一失败阻断上传与发送；`sendPoster` 真实发送前强制校验，失败返回 `blocked` |
| `...\GameNewsUnified\server\tasks\pipeline.mjs` | P0#2 日海报独立视觉模板（`buildDailyPosterHtml`）+ 周报视觉模板（`buildWeeklyPosterHtml`）；P1#4 图片接入（`pickDailyArticles` 增加 image_url/facts_json/images_json，`imageUrlForPoster` 新游用 ICON、活动用首图）；`buildPosterItems` 补评级/评分/标签 |
| `...\GameNewsUnified\tests\poster.test.mjs` | 新增：端口断言、PNG 错误页判定、分区隔离、图片接入、评级排序、端游资讯上限 15、周报模板 |

未改文件说明：`config.mjs`/`scheduler.mjs`（任务时间/发送对象/启停未动）；前端 `src/*` 未动；`api-server.mjs` 未动。

## 二、测试

- 副本 `npm test`：**74/74 通过**（新增 poster.test.mjs 8 用例；既有 67 全保留）。

## 三、证据（副本 `output\poster-evidence\`）

| 产物 | 结果 |
|---|---|
| `简讯海报-2026-08-27.html`（44.8KB） | 全分区（新游35/活动17/Steam8/端游资讯26→15） |
| `简讯海报-2026-08-27.png`（2.03MB，1100×16000） | 四层校验 **ok:true**：HTTP 39062B / DOM section20 card75 / 图片 12 加载成功 / PNG 尺寸正常 |
| `简讯海报-2026-08-27.top.png`（656KB，顶部 1800px） | 人工核对：masthead、双栏、ICON/首图真实渲染、日期分组 |
| `validation-2026-08-27.json` | 校验日志（可追溯） |
| `blocked-demo.json` + `bad-error.png` | 错误页阻断实证：不存在路径 → HTTP 404 → 四层校验 **ok:false** → 阻断发送 |

页面截图说明：顶部截图已由 Read 工具核验（masthead"今日简讯"+日期+双栏+图片渲染正常）；TRAE 浏览器扩展不可用，故用 Edge headless 截图作为页面证据。

## 四、边界遵守

- 未读取/打印 `.env.local`；未写正式目录/正式库/副本库；未调用飞书上传/发送（证据仅 dry-run/本地）。
- 临时 HTTP 服务（端口 64510/64511）仅用于本地截图，脚本内 `try/finally` 保证结束后停止；无持久进程。
- 旧 GameNews 未停、未改；正式项目 64504/scheduler 未受影响（本次未推正式）。
- 副本库只读打开（`readOnly: true`）；证据生成未写入数据库。

## 五、回退

- 本次改动全部在 TraeWork 副本；正式目录未接收任何改动，无需回退正式。
- 副本改动为独立新增/替换（poster.mjs、pipeline.mjs、tests/poster.test.mjs）；如需放弃，删除/还原这三文件即可（副本既有 67 测试仍会通过）。
- 证据目录 `output/poster-evidence/` 为新增，可整体删除。

## 六、待 Codex 复核/关注

1. **时间树实现**：当前用"日期分组标题"作为时间树节点（新游左栏/活动右栏双列），非传统竖线时间轴。如需严格竖线节点可在此模板上增强（`tl-node`/`tl-grid`/`tl-list` 已结构化）。
2. **端游资讯截断**：日海报默认 `pickDailyArticles` limit=60（与简讯共用），行业资讯因分数低可能不进海报；模板已支持（上限 15）。若希望海报独立扩量，可给 `pickDailyArticles` 传入更大 limit（证据用 `--limit 200` 已演示全分区）。
3. **周报**：已升级为视觉模板（概览表 + 带图近期列表），未移植旧 weeklyPoster.js 全部特性（14 天时间树详情）；如需深度对齐可继续。
4. **图片远程可达性**：校验"至少 1 张图片加载成功"通过（本地网络可达 CDN）；若未来网络隔离，图片层可能 fail 并阻断发送——符合"失败即阻断"原则。
5. **切换结论**：海报 HTML/PNG/校验层证据已具备；飞书上传/发送真实验收需用户授权后进行（本轮未做真实发送），未满足前**不停止旧 GameNews 双跑**。
