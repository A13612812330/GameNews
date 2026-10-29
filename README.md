# GameNewsUnified

统一游戏资讯数据中心：GameNews（爬虫/简讯/海报/周报/飞书）+ WX News Wiki（网站/编辑工作流）+ WorkBuddy Steam 三源历史数据。

## 快速开始
```bash
node db/apply-schema.mjs          # 应用 schema（新建 data/game-news-unified.sqlite）
node scripts/migrate-legacy.mjs   # 迁移旧数据（幂等；--dry-run 只统计）
node server/api-server.mjs        # 启动 API + 前端（http://127.0.0.1:64500）
node --test                       # 运行单元测试
```

## 目录
- `schema.sql`                统一数据库 Schema（v1）
- `docs/field-mapping.md`     旧库→新库字段映射
- `docs/migration-report-P2.md` 迁移报告
- `docs/steam-import-report-P4.md` Steam 三源导入与数据等级口径
- `docs/screenshots/`         P5 前端截图（桌面 + 390px）
- `db/apply-schema.mjs`       应用 schema
- `scripts/migrate-legacy.mjs` 迁移脚本（--dry-run 可重复执行）
- `server/api-server.mjs`     零依赖 API 服务（node:http + node:sqlite）
- `server/rules/`             统一规则层（清洗/优先级/去重/评级），三个出口唯一入口
- `server/steam/`             Steam AppID 映射 + 实时快照写入层
- `server/ai/`                AI 分析记录层契约（模型/提示词待配置）
- `public/`                   前端控制台（资讯工作台/来源/Steam分析/简讯/飞书/运行台）
- `tests/`                    单元测试（16 项：rules + steam/ai）
- `backups/2026-08-26/`       P0 冻结基线备份（含哈希清单）

## 前端（资讯网站 + 控制台合并，同一应用）
- **资讯网站（读者向）**：首页资讯流（Hero + 分类页签 + 卡片网格）、文章详情页（可读排版/正文/图片/事实/原文链接）、Steam 数据看板、简讯/海报/周报归档浏览。
- **控制台（编辑/运维）**：资讯工作台 / 抓取与来源 / Steam 分析 / 简讯海报周报 / 飞书与评级 / 运行台。
- 侧栏分「资讯网站」「控制台」两组导航，同一应用路由切换，切换不丢状态。

## 约束
- Steam AppID 是 games 唯一主键；快照只追加。
- AI 结论只写 ai_analyses，不写回原始字段；模型/提示词未配置前禁止自动发布。
- 迁移只增不删，保留 legacy_id / source_system。
- 实时 Steam 采集器保留自 GameNews（不重写），统一项目只负责写库。
