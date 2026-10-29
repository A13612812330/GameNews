# P2 数据迁移报告（GameNewsUnified）

> 批次：P2-2026-08-26　执行时间：2026-08-26　数据源：P0 冻结备份（只读）+ WorkBuddy 三源数据包
> 迁移方式：幂等脚本 `scripts/migrate-legacy.mjs`（已连续运行 2 次验证幂等，计数稳定）

## 1. 迁移汇总

| 目标表 | 读入 | 写入 | 跳过 | 冲突 | 重复 | 说明 |
|---|---|---|---|---|---|---|
| sources | 13 | 8 | 0 | 0 | 5 | GameNews(6)+WX(7) 共享 5 个来源 id，已按 id 合并 |
| articles | 989 | 989 | 0 | 0 | 0 | GameNews.articles 279 + WX.crawler_records 710 |
| events | 989 | 981 | 0 | 0 | 0 | 由含 game_name 的文章派生，保留 source_article_id/source_url |
| editorial_drafts | 32 | 32 | 0 | 0 | 0 | WX 草稿 |
| briefs | 33 | 33 | 0 | 0 | 0 | GameNews 简讯（WX briefs 为空） |
| games | 156* | 60 | - | - | - | 60 个 Steam AppID，唯一 |
| steam_snapshots | - | 136 | - | - | - | current_online 60 + peak_online 76（③60+④16） |
| steam_source_metrics | - | 340 | - | - | - | search 300（60×5）+ jingyun 40（20×2） |
| game_aliases | - | 210 | - | - | - | cn 70 / en 60 / jingyun 20 / search 60 |

\* games 读入 156 为 ③(60)+④(16) 条源记录；④的 16 个 AppID 全部与③重叠，upsert 合并后 games 实际 60 行。

## 2. 验收对照

### DB-02 Steam 四表导入
- ✅ games 60 行、distinct appid 60（唯一）
- ✅ ③Steam源 60 款：current_online 快照 60 条
- ✅ ①搜索关键词源 60 → search metrics 300（总搜索/7月/8月/增长/相关性 × 60），data_grade=demo
- ✅ ②鲸云源 20 → jingyun metrics 40（游玩/注册人数），data_grade=history
- ✅ ④三源关联 16 → peak_online 快照 + games 补齐，data_grade=history

### DB-03 字段可追溯
- 游戏：cn_name（清洗值）/ name（原始原名）/ release_date / first_seen_at（采集时间）/ imported_batch 均存在；原始整行存于 steam_snapshots.raw_json；来源标记 snapshot_source=workbuddy-history。
- 事件：title（原始）/ event_type（清洗）/ source_url / created_at（采集时间）/ imported_batch 均存在。
- **已知局限**：WorkBuddy 三源数据本身不含 URL 字段，games 无"来源URL"列；其出处以 snapshot_source + raw_json 全量保留。

## 3. 人工评级与原文链接
- ✅ 原文链接：articles.detail_url 全部保留（GameNews 与 WX url 均映射）。
- ✅ 评级/复核数据：GameNews 的 quality / score / review_status / selected_for_brief 已随 articles 迁移。
- ⚠️ 结构化人工评级（S/A/B/C）：源系统中未发现既有数据，`ratings` 表留空待新系统使用（未丢弃任何已有评级）。

## 4. NewgameWiki 只读审计（未导入数据）
- 表量：game_records 3,822 / history 2,000 / daily_snapshots 30 / scheduler_jobs 9 / scheduler_runs 1,043 / 平台参考 3,280 / 福利参考 429。
- 9 个任务全启用：游侠网、游民星空、机核、好游快爆、九游、Steam游戏、Steam新游、TapTap、小七手游。
- game_records 来源分布：游民星空 1,044 / TapTap 701 / 游侠网 656 / Steam 455 / 机核 299 / 好游 217 / 小七 214 / 九游 123 / 组合来源若干。
- **结论**：与 GameNews 来源（TapTap/好游/游民/机核/小七/Steam）高度重叠，另有游侠、九游独有。按规划一期**不并入**运行时爬虫；其独有数据（如九游、游侠记录）如后续需要，再单独抽样导入。本审计只读 P0 备份，未触碰运行中的 64111 库。

## 5. 旧库未被写入确认
- 迁移全程仅从 `backups/2026-08-26/*`（P0 只读副本）读取；未对 GameNews / WX / NewgameWiki 的任何线上库执行写操作。
- 基线哈希见 `backups/2026-08-26/baseline-manifest.json`。

## 6. 待提供/待决（沿用规划 §05）
- Steam 数据包生成脚本（Excel/JSON 来源）未提供。
- AI 分析：模型/权限/提示词/输出格式/是否自动发布未提供 → ai_analyses 契约已建表，等待配置。
- 飞书密钥位置未提供 → 迁移阶段未涉及，P5/P6 需要时再确认。
