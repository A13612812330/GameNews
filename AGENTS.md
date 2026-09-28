# GameNews 项目协作规则

## 项目边界

- 项目根目录：`E:\新建文件夹\Codex-GPT\GameNews`
- 日常服务端口只有一个：`64424`。`server/index.js` 用 `express.static` 同时托管前端 `dist/` 与 `/api`，浏览器直接访问 `http://127.0.0.1:64424/`。
- 前端热更新端口 `64423` 仅供开发，由守护脚本按 `GAMENEWS_DEV_CLIENT=1` 决定是否启动，**默认不监听**，不要把它当成日常入口。
- **`64425` 是对外暴露面，禁止并入 `64424`**：Cloudflare 隧道（`data/poster-public-tunnel.json`）直指 64425，只放行海报静态资源。若合并到 64424，`/api/*` 会一并被公网访问到。
- 前端通过 Vite proxy 访问 `/api` 和 `/crawler-assets`，不要在组件中硬编码后端地址。
- 默认不读取、打印或提交 `.env`、API 密钥和敏感配置。
- 修改数据库表结构前必须先确认；现有 `server/database.js` 使用 SQLite，业务表为 `sources`、`articles`、`briefs`。
- 爬虫目标只限项目中已配置的授权来源，不扩大站点扫描范围。
- 爬虫修复与前端视觉调整分开验证，避免用 UI 改动掩盖采集问题。

## 技术与代码约定

- Node.js ESM、Express 5、React 19、Vite 8、SQLite `node:sqlite`。
- React 页面使用函数组件和 Hooks；路由使用 URL hash，不引入新的路由框架。
- 共用设计变量放在 `src/design-system.css`，通用布局放在 `src/styles.css`，页面专属样式使用独立 CSS 文件。
- API 请求优先复用 `src/services/api.js` 的 `request()` 封装。
- 详情抓取必须保留失败隔离；单个页面或图片失败不应让整批任务失败。
- 清洗逻辑必须可重复运行，不得无备份地批量删除历史数据。
- 生成目录、SQLite 数据库、爬虫图片和日志属于运行产物，不应被当作源码重构。

## 常用验证

```powershell
npm run build
npm run check:crawler
Invoke-WebRequest http://127.0.0.1:64424/api/health
```

浏览器验证重点：主题持久化、今日简讯分类导航、抓取资讯的两阶段操作、简讯编辑的历史/拖拽/保存，以及 390px 移动端无横向溢出。
