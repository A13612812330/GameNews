# GameNewsUnified 下一阶段执行单（交给 TraeWork）

> 日期：2026-08-27
> 正式运行目录：`E:\新建文件夹\Codex-GPT\GameNewsUnified`
> 目标：保持正式服务可用，收敛副本差异，补齐公网海报与迁移切换前置条件。

## 一、当前已确认状态

- 正式 API：`http://127.0.0.1:64504/`，健康检查正常。
- 守护脚本已运行：`scripts/run-unified-service.ps1`，同时守护 API 与 scheduler；日志在 `logs/`。
- scheduler 已完成首轮 monitor：6 个来源全部成功，并完成飞书增量同步。
- React 在 390px 首页、管理任务页均无横向溢出。
- `npm run build` 成功；`npm test` 为 56/56 通过。
- 旧 `GameNews` 仍在双跑，**不得停止**。

## 二、TraeWork 必须执行

### 1. 同步正式目录差异到 TraeWork 副本

来源目录：`E:\新建文件夹\Codex-GPT\GameNewsUnified`

需要同步：

- `server/tasks/scheduler.mjs`
  - 新增 `activeHours` 实际判断，确保 monitor 只在 08:00–23:00 运行。
- `scripts/run-unified-service.ps1`
  - API（64504）+ scheduler 的守护、自动重启和日志落盘。
- `package.json`
  - 以正式目录为准，保留 React/Vite、lucide、`build`、`dev:web` 等前端依赖和脚本。

禁止同步或覆盖：

- `.env.local`
- `data/`
- `output/`
- `logs/`
- `backups/`

同步后必须在 TraeWork 副本执行：

```powershell
npm run build
npm test
```

验收标准：构建成功，56/56 测试通过；不得修改正式数据库、飞书数据或旧项目任务。

### 2. P1：正式公网海报地址

当前 `POSTER_BASE_URL` 是本机 `127.0.0.1`，飞书群外无法打开。

请实现**命名 Cloudflare Tunnel + 稳定域名**，不要使用重启后会变更地址的 quick tunnel。

要求：

- Tunnel 指向 `http://127.0.0.1:64504`。
- 正式域名可访问 `/output/...` 海报 HTML。
- 仅在获得 Cloudflare Tunnel 凭据/域名后，将公网地址写入正式目录 `.env.local` 的 `POSTER_BASE_URL`。
- 不在代码、文档、日志或 Git 中记录凭据。

验收标准：使用飞书消息中的海报 URL，在非本机网络可访问；PNG 仍可由本机生成。

### 3. P2：迁移切换前补齐采集覆盖

当前旧项目简讯与统一项目 URL 覆盖为 **10/12**，尚不能切换。

缺失条目：

- 《星球大战：银河赛车手》全新宣传片公布！10月6日发售
- 恶搞动作冒险《Trees Hate You》预告，11 月发售

同时修复：`西游大冒险` 在统一库中存在 article、但缺少 event 的问题。

验收标准：

- 同日旧简讯 12 个原文 URL 均能在统一库 `articles.detail_url` 中找到。
- `西游大冒险` 存在对应 event。
- 重跑 `scripts/double-run-compare.mjs --date 2026-08-27`，提供报告。

在上述验收未通过前：**不得停止旧 GameNews 双跑，不得将统一项目标记为唯一生产来源。**

### 4. P0：SYSTEM 级开机自启（需管理员权限时再做）

当前用户登录自启已经存在：

`C:\Users\komo\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\GameNewsUnified-Service.cmd`

但系统拒绝当前会话创建计划任务，因此“电脑开机、未登录也常驻”未完成。获得管理员权限后执行：

```powershell
$script = 'E:\新建文件夹\Codex-GPT\GameNewsUnified\scripts\run-unified-service.ps1'
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes("& '$script'"))
schtasks /Create /TN "GameNewsUnified-Service" /SC ONSTART /RU SYSTEM /RL HIGHEST /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand $encoded" /F
```

验收标准：重启后 64504 监听，`/api/health` 返回 `ok: true`，`logs/service-supervisor.log` 有启动记录。

## 三、禁止操作

- 不停止旧 `GameNews` 双跑。
- 不删除或覆盖飞书 Base 历史记录。
- 不修改 `.env.local` 中的密钥值，除非只更新已确认的 `POSTER_BASE_URL`。
- 不重新引入 `public/app.js`、`public/styles.css` 作为前端入口。
- 不处理 C 级筛选、评级算法、采集清洗规则以外的产品改动；先完成本执行单。

## 四、回传格式

请回传以下内容：

1. 实际同步文件及 SHA-256 对比结果。
2. build/test 输出摘要。
3. Cloudflare Tunnel 的域名（不含凭据）及外网访问验证。
4. 12/12 URL 覆盖对比报告和 `西游大冒险` event 证据。
5. SYSTEM 级计划任务是否创建成功、重启后健康检查结果。
6. 任何无法执行事项的明确原因与所需权限，不要标记为已完成。
