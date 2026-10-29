# 旧库 → 新库 字段映射（GameNewsUnified）

> 映射依据：GameNews / WX News Wiki / WorkBuddy 三源数据包（2026-08-26 P0 冻结备份）。
> 迁移原则：只增不删；保留 legacy_id 与 source_system；游戏名称不作为唯一键。

## 1. 来源 sources

| 源系统 | 源表 | 目标表 | 说明 |
|---|---|---|---|
| GameNews / WX | sources | sources | 按 id 合并；GameNews 6 个 + WX 7 个；同 id 的 urls 合并去重 |

## 2. 资讯 articles

| 源系统 | 源表 | 源字段 | 目标字段 | 转换说明 |
|---|---|---|---|---|
| GameNews | articles | id | id, legacy_id | id = `gn:{legacy_id}` |
| GameNews | articles | source_id/source_name/title/game_name/category/detail_url/image_url/date_text/score | 同名字段 | 1:1 |
| GameNews | articles | paragraphs/facts/images_json | paragraphs_json/facts_json/images_json | 原样保留 JSON 文本 |
| GameNews | articles | quality/game_match/diagnostic/review_status/selected_for_brief/reviewed_at | 同名字段 | 1:1 |
| GameNews | articles | ai_summary | ai_summary | 仅历史值；新 AI 结论走 ai_analyses |
| GameNews | articles | discovered_at/updated_at | 同名字段 | 1:1 |
| WX | crawler_records | id | id, legacy_id | id = `wx:{legacy_id}` |
| WX | crawler_records | record_type/status | status | `candidate`/detail→status 保留 |
| WX | crawler_records | payload | payload_json | 原样保留 |
| WX | crawler_records | score/quality/created_at/updated_at | 同名字段 | 1:1 |

## 3. 草稿 editorial_drafts

| 源系统 | 源表 | 源字段 | 目标字段 |
|---|---|---|---|
| WX | drafts | id/title/status/template_id/payload/created_at/updated_at | legacy_id/title/status/template_id/payload_json/created_at/updated_at (id=`wx-draft:{id}`) |

## 4. 简讯 briefs

| 源系统 | 源表 | 源字段 | 目标字段 |
|---|---|---|---|
| GameNews/WX | briefs | id/title/style/max_length/lead/template_id/total_characters/reading_minutes/sections_json/source_notes/status/slot/published_at/created_at/updated_at | legacy_id + 同名 (id=`{system}:{id}`, source_notes_json) |

## 5. Steam 三源 → games / steam_snapshots / steam_source_metrics / game_aliases

| 源 | 源字段 | 目标表/字段 | 说明 |
|---|---|---|---|
| ③Steam源(60) | appid | games.appid (PK) | AppID 唯一主键 |
| ③ | 中文名称/游戏名称(原名) | cn_name/name + game_aliases(cn/en) | 别名表用于检索 |
| ③ | 开发者/玩法标签/发行日期/安装大小/独立游戏/最低配置/推荐配置 | games 对应字段 | 1:1 |
| ③ | 当前在线(8/25)/近一年峰值/峰值日期 | steam_snapshots | metric_name=current_online/peak_online, snapshot_at=发行日期所在口径, data_grade=history |
| ①搜索关键词源(60) | 端游名称(中文)/总搜索次数/7月/8月/8月相对增长/相关性 | steam_source_metrics (source_kind=search) | data_grade=demo（规划：虚拟演示数据） |
| ②鲸云源(20) | 鲸云游戏名称/游玩人数/注册人数/Steam对应游戏/appid/备注 | steam_source_metrics (source_kind=jingyun) | appid 可空（“—”）；data_grade=history |
| ④三源关联(16) | 游戏/appid/玩法标签/独立游戏/发行日期/安装大小/历史峰值/判定说明/最低/推荐配置 | games(补齐) + steam_snapshots(peak) + game_aliases(全称) | 判定/说明保留在 raw 与 extra |

## 6. 图片 assets

GameNews.articles.images_json → assets；src 为 /crawler-assets/... 引用（按引用迁移图片文件，见 P2 图片步骤）。

## 7. AI / 评级 / 通知

| 目标表 | 来源 | 说明 |
|---|---|---|
| ai_analyses | （新） | AI 结论层；与原始数据隔离 |
| ratings | GameNews 人工评级（若有）/新 | ref_type+ref_id+source 唯一 |
| notifications/deliveries | （新） | 飞书发送指纹防重复 |
