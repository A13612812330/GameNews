# P4 Steam 与 AI：快照导入报告与数据口径

> 生成：2026-08-26　目标库：`E:\新建文件夹\Codex-GPT\GameNewsUnified\data\game-news-unified.sqlite`

## 1. 三源历史快照导入（已完成，见 P2）

| 来源 | 记录数 | 落库方式 | data_grade |
|---|---|---|---|
| ③Steam源(近一年·60款) | 60 | games + steam_snapshots(current_online 60 / peak_online 60) | history |
| ①搜索关键词源 | 60 | steam_source_metrics(source_kind=search, 每款 5 指标) | **demo**（规划：虚拟演示数据） |
| ②鲸云源 | 20 | steam_source_metrics(source_kind=jingyun, 每款 2 指标) | history |
| ④三源关联重点表 | 16 | games(补齐) + steam_snapshots(peak) + 判定/说明保留 raw_json | history |

- `steam_snapshots` 共 136 条（current_online 60 + peak_online 76），只追加不覆盖（UNIQUE appid+snapshot_at+source+metric）。
- 快照口径：current_online 取数据包标注的 2026-08-25；peak 取峰值日期。

## 2. 数据等级口径（实时 / 历史 / 演示）

| 等级 | 含义 | 允许展示 | 禁止 |
|---|---|---|---|
| realtime | GameNews Steam 采集器实时抓取（保留自 GameNews，未重写） | 作为实时数据展示 | 用历史/演示数据冒充 |
| history | 三源历史快照（2026-07-01~08-25） | 标注"历史快照 + 采集时间" | 当作实时在线数据 |
| demo | ①搜索关键词源（虚拟演示数据） | 标注"演示/历史" | 作为真实搜索趋势 |

前端（P5）必须用标识区分三档，禁止混在同一个排行榜里。

## 3. Steam AppID 映射
- `server/steam/appid-map.mjs`：game_aliases 精确命中 → games.cn_name/name 规范化命中 → 模糊后缀剥离 → null。
- 已用目标库实测：`求生之路2 / Left 4 Dead 2 / L4D2 → appid 550`。

## 4. 实时采集器复用说明
- 实时主线保留 GameNews 的 `server/crawler/platforms/steam.js`（官方 featuredcategories/appdetails、中国区商店页、热玩/畅销榜、Firecrawl 兜底），**不重写**。
- 统一项目的 `server/steam/realtime.mjs` 只负责把采集结果写入 `games`(upsert) + `steam_snapshots`(append)，并带 AppID 映射。
- 采集器与统一库的接线在 P5/P6 的服务运行时完成；P4 已通过单测验证写入路径（STEAM-01）。

## 5. AI 分析层（ai_analyses 契约）
- `server/ai/analysis.mjs`：run() 记录 AI 结论（含输入快照/模型/提示词版本/置信度）；override() 人工修正；原始表一律不写（AI-01 已测）。
- `server/ai/config.mjs`：模型/密钥/提示词、是否自动发布均为**待提供**；当前 `model=null`、`promptVersion=v0-unconfigured`、`autoPublish=false`，禁止真实推理与自动发布。
- 提示词版本登记表 PROMPT_VERSIONS：每次改提示词必须新增版本号。

## 6. 验收对照
- STEAM-01 ✅ 同一 AppID 两次采集 → 两条快照均在（单测通过）
- STEAM-02（数据等级显示）→ P5 前端实现
- AI-01 ✅ AI 隔离 + 人工优先 + 版本/时间可追溯（单测通过）
