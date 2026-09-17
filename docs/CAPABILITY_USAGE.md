# 能力、Skill、插件与 Agent 记录

本文档记录“本项目相关对话中已知的能力使用情况”，不代表每次启动项目都会自动调用所有能力。

## 本轮文档整理实际使用

| 能力 | 用途 | 结果 |
|---|---|---|
| `project-analysis` | 盘点项目、入口、模块、数据流、契约、风险和新人阅读路径 | 已读取并按其标准结构整理 |
| `context-engineering` | 把项目规则沉淀为 `AGENTS.md`，减少后续重新解析时的上下文漂移 | 已新增项目级规则文件 |
| `komo-agent` | 按用户的全局工作流解释能力边界和优先级 | 已读取；本项目没有独立 Agent 运行时 |

## 本项目此前相关工作中使用或涉及

| 能力 | 用途 | 当前项目对应内容 |
|---|---|---|
| `frontend-design` | 今日简讯页面和整体 UI 设计 | `DashboardPage.jsx`、`dashboard-page.css`、`styles.css` |
| `frontend-polish-review` | 页面层级、间距、主题、移动端和交互反馈优化 | AppShell、今日简讯和通用样式 |
| `browser-testing` | 页面启动、接口和浏览器验证流程 | 当前浏览器运行时曾因 Chromium 缺失而未完成截图验收 |
| `firecrawl` | 网页动态抓取和详情回退设计 | `server/crawler/rateLimiter.js` 使用 Firecrawl SDK |
| `playwright` | 预期用于 UI 自动化和截图 | 项目当前没有正式 Playwright 测试脚本 |

## 可用插件

当前 Codex 环境提供的相关插件包括：

- `browser`：浏览器页面控制
- `chrome`：Chrome 相关控制
- `computer-use`：Windows 界面操作
- `figma`：设计协作
- `hyperframes`：视频/动效工作流
- `superpowers`：计划、调试、测试和多 Agent 协作流程

本项目最近一次前端优化没有直接修改或安装这些插件；它们属于环境能力，不是项目运行时依赖。

## MCP / 外部能力边界

已知可用 MCP：

- `filesystem`：读取和修改项目文件
- `terminal`：运行构建、脚本和服务命令
- `node_repl`：Node 环境和浏览器自动化尝试
- `github`：仓库、Issue、PR 上下文

本项目代码本身只依赖 Firecrawl 外部服务，不依赖 MCP 才能运行。

## Agent 说明

- 项目内没有发现独立的 Agent、模型调用、工具注册表或 Agent 状态机代码。
- `komo-agent` 是 Codex 侧的总控路由 Skill，不是 GameNews 服务中的业务 Agent。
- 本项目此前没有完成独立子 Agent 分工或多 Agent 代码提交；后续如果采用，应把任务边界和审查结果单独记录。

## 以后调用建议

| 任务 | 优先能力 |
|---|---|
| 项目重新解析/制定方案 | `project-analysis` + `context-engineering` + `komo-agent` |
| 前端页面和视觉 | `frontend-design` + `frontend-polish-review` + `browser-testing` |
| 爬虫和动态页面 | `firecrawl`，需要站点发现时再加 `katana-crawl` |
| 回归测试和调试 | `browser-testing`、`playwright`、`superpowers:systematic-debugging` |
| SQLite 数据检查 | `sqlite-mcp-server`，先备份再执行有副作用脚本 |

## 事实等级

- **已观察**：来自当前项目源码、`package.json`、脚本或配置。
- **运行验证**：通过 `npm run build`、`npm run check:crawler` 或健康接口确认。
- **关联能力**：环境中可用或此前任务涉及，但不代表本次一定实际调用。
- **待确认**：需要用户个人方案决定，尤其是自动流水线、数据库字段和清洗策略。
