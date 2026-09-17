# 其他电脑安装与飞书配置

## 1. 获取项目

```powershell
git clone <你的私有仓库地址>
cd GameNews
npm install
```

## 2. 配置飞书

复制 `.env.example` 为 `.env.local`，或将同名变量写入 Windows 用户环境变量。真实 App Secret、群 ID、Base Token 只保留在本机，不能提交到 GitHub。

| 用途 | 必填变量 |
| --- | --- |
| 日报/周报海报机器人 | `FEISHU_POSTER_APP_ID`、`FEISHU_POSTER_APP_SECRET`、`FEISHU_POSTER_CHAT_ID` |
| 新游/活动提醒机器人 | `FEISHU_TOPIC_APP_ID`、`FEISHU_TOPIC_APP_SECRET`、`FEISHU_TOPIC_CHAT_ID` |
| 飞书游戏库 | `FEISHU_MONITOR_APP_ID`、`FEISHU_MONITOR_APP_SECRET`、`FEISHU_MONITOR_APP_TOKEN`、`FEISHU_MONITOR_TABLE_ID`、`FEISHU_MONITOR_RATING_TABLE_ID` |

## 3. 启动

```powershell
npm run start
```

- 前端：`http://127.0.0.1:64423/#/dash`
- 后端健康检查：`http://127.0.0.1:64424/api/health`

## 4. 日报与周报 GitHub 归档

海报生成后，`scripts/publish-github-posters.ps1` 会把以下文件同步到仓库：

- `published-posters/daily/YYYY.M.D-今日简讯海报.html`
- `published-posters/daily/YYYY.M.D-今日简讯海报.png`
- `published-posters/weekly/YYYY.M.D-周简讯海报.html`

首次安装后运行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-github-poster-sync-task.ps1
```

该任务每天 09:00 运行；无新增内容不会创建空提交。
