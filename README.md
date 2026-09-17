# GameNews

GameNews 是一个中文优先的游戏资讯聚合与简讯编辑工具。它从好游快爆、TapTap、九游、游民星空、机核、游侠网和 Steam 等来源获取候选资讯，经平台过滤、评分、去重和详情解析后，供用户筛选并生成今日简讯。

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
