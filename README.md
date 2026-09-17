# GameNews

> 中文游戏资讯采集、编辑、海报生成与飞书投递工具。

GameNews 面向手游资讯分发场景：从 TapTap、好游快爆、九游、游民星空、机核、游侠网、Steam 等来源采集候选内容，完成清洗、去重、游戏识别与优先级筛选，再生成可编辑的今日简讯、日报海报和周报海报。

## 项目包含什么

- **资讯采集与清洗**：按来源抓取游戏资讯、新游、测试、版本更新和活动，并保留原文链接。
- **简讯编辑后台**：在本地后台查看抓取结果、筛选内容、调整排序并生成今日简讯。
- **日报/周报海报**：生成 HTML 与 PNG 海报；正式产物归档在 `output/scheduled-posters/`。
- **飞书集成**：支持飞书游戏库同步，以及海报机器人、新游/活动提醒机器人投递。
- **本地定时运行**：爬虫监控、日报、周报、留档清理均由本机服务调度。
- **GitHub 海报归档**：`published-posters/daily/` 与 `published-posters/weekly/` 仅保存对外归档的日报、周报，默认每日 09:00 自动同步到本私有仓库。

> 安全说明：真实飞书密钥、群 ID、本地数据库、采集缓存、日志和备份均不会提交到 GitHub；跨电脑部署请复制 `.env.example` 为本机私有配置后再填写。

## 当前入口

- 前端：`http://127.0.0.1:64423/`
- 后端健康检查：`http://127.0.0.1:64424/api/health`
- 资讯页面：`#/feed`，界面名称为“抓取资讯”
- 简讯页面：`#/brief`，界面名称为“简讯编辑”
- 今日简讯：`#/dash`

## 快速启动

```powershell
cd E:\新建文件夹\Codex-GPT\GameNews
npm install
npm run dev
```

生产构建：

```powershell
npm run build
npm run preview
```

更多架构、数据规则、API 契约、风险和能力记录见：

- [docs/PROJECT_ANALYSIS.md](docs/PROJECT_ANALYSIS.md)
- [docs/OPERATING_RULES.md](docs/OPERATING_RULES.md)
- [docs/CAPABILITY_USAGE.md](docs/CAPABILITY_USAGE.md)
- [AGENTS.md](AGENTS.md)
