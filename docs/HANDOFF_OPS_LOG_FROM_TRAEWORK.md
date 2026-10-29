# 操作日志：GameNewsUnified 收尾（TraeWork 执行，供 Codex 审查）

> 日期：2026-08-27 18:0x（Asia/Shanghai）
> 依据：`docs/HANDOFF_CLASSIFICATION_AND_FEISHU_AUDIT_FROM_CODEX.md` + 用户指令"接管后续收尾"
> 范围：① scheduler 受控重启 ② TapTap 话题误入"新游"分类回归 ③ Vite 构建不再携带旧 app.js/styles.css
> 运行目录：正式 `E:\新建文件夹\Codex-GPT\GameNewsUnified`；工作副本 `e:\新建文件夹\TraeWork\6a8e97b0c36a13e47a2f964a\GameNewsUnified`

## 〇、红线遵守（全部满足）

- 未修改 `.env.local`（未读取/打印/覆盖其中任何密钥）
- 未停止旧 `GameNews` 双跑（vite 64423、旧 server 等进程未动）
- 未删除/覆盖/重排飞书 Base 历史记录
- 未改前端源码结构（`src/App.jsx`、`unified.css`、页面结构均未动）
- 只读旧库（`GameNews/data/game-news-hub.sqlite` 仅 SELECT）

---

## 一、任务 1：scheduler 受控重启

### 1.1 摸底（关键事实）

- Codex 已在**正式目录** scheduler.mjs 加入日志收敛 `summarizeResult`，但常驻进程（旧 PID 20256，16:40 启动）仍是改动前代码：
  - 旧日志 `scheduler-20260827-164016.out.log` 输出**完整飞书同步对象**（audit/createdRecords/updatedRecords/ambiguityList 等）。
  - 该旧进程在 16:40–18:06 间**仍在跑 monitor + 真实飞书同步**（含把此前回填的《星球大战：银河赛车手》《Trees Hate You》按"新游"写入飞书主表）。
- `isDue` 对 interval 任务"首次立即"触发 → 直接重启会立即采集 + 触发真实 S/A 提醒。
- supervisor（`run-unified-service.ps1`，PID 34808）在跑，杀掉 scheduler 子进程会自动用最新代码拉起（无需重启 supervisor）。

### 1.2 代码改动（server/tasks/scheduler.mjs，两项目一致）

1. **safe-first 播种**：守护启动时为 interval 任务（monitor/steam）播种 `lastRun=启动时刻`，首个周期内不触发：

```js
let firstMonitorPending = true;
export function seedSafeFirst(tasks = TASKS, now = new Date()) {
  const seeded = [];
  for (const t of tasks) {
    if (!t.enabled || !t.intervalMinutes) continue;
    lastRun.set(t.id, { ts: now.getTime(), dateKey: dateKeyOf(now) });
    seeded.push(`${t.id}(${t.intervalMinutes}min)`);
  }
  return seeded;
}
```

2. **首次 monitor 不通知**（双保险，即使首个周期内触发也不发真实提醒）：

```js
monitor: { desc: "每小时监控（8:00-23:00）", fn: async (db, _date, opts = {}) => {
  const runnable = Object.keys(ADAPTERS).filter((k) => ADAPTERS[k].runnable);
  const summary = await runSources(runnable, { runKind: "monitor" });
  const feishu = await maybeSyncFeishu(db, { notify: opts.notify !== false }); // 受控重启后首次 notify=false
  return { summary, feishu };
} },
```

```js
async function runLoop({ once = false, intervalSeconds = 30, safeFirst = true } = {}) {
  console.log(`[调度] 守护启动，每 ${intervalSeconds}s 检查（once=${once}${safeFirst ? ", safe-first" : ""}）`);
  if (safeFirst) { const seeded = seedSafeFirst(); if (seeded.length) console.log(`[调度] safe-first 播种（${seeded.join(", ")}）：重启后首个周期不立即采集/提醒`); }
  let loop = true;
  while (loop) {
    const now = new Date();
    for (const t of TASKS) {
      if (!t.enabled) continue; if (!RUNNERS[t.id]) continue; if (!isDue(t, now)) continue;
      lastRun.set(t.id, { ts: now.getTime(), dateKey: t.runAt?.weekday != null ? weekKeyOf(now) : dateKeyOf(now) });
      const opts = t.id === "monitor" && firstMonitorPending ? { notify: false } : {};
      if (t.id === "monitor") firstMonitorPending = false;
      try { await runOnce(t.id, undefined, opts); } catch (e) { console.error(`[调度] 执行异常 ${t.id}:`, e.message); }
    }
    if (once) loop = false; else await sleep(intervalSeconds * 1000);
  }
  console.log("[调度] 守护退出（once 完成）");
}
```

3. **可测试化**：`main()` 加主模块守卫（import 不启动守护）；导出 `isDue`/`withinActiveHours`/`seedSafeFirst`/`summarizeResult`；`--no-safe-first` 可关闭播种。

```js
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
export { isDue, withinActiveHours };
```

4. 日志收敛沿用 Codex 的 `summarizeResult`（monitor 只输出 `来源:状态:发现/新增` 与 `inserted/actualUpdated/ambiguous/alerts/queued/attempted/sent/failed`；daily-brief/weekly 只输出文件与海报状态），未改动其逻辑。

### 1.3 测试（tests/scheduler-safe-first.test.mjs，4 条）

- interval 播种后首个周期内 `isDue` 为 false；一个周期后为 true
- runAt 型任务（简讯 09:30）不受播种影响，到点仍触发
- monitor 摘要不含飞书消息ID/事件正文/审计对象（`JSON.stringify` 断言）
- daily-brief 摘要只含文件路径与海报状态

### 1.4 执行与验证

- 推送到正式项目后 `Stop-Process` 杀掉旧 scheduler（PID 20256）→ supervisor 自动拉起新进程（PID 9340，18:06:08）
- 新日志 `scheduler-20260827-180608.out.log`（当前仅 2 行，无任务执行）：

```
[调度] 守护启动，每 30s 检查（once=false, safe-first）
[调度] safe-first 播种（monitor(60min), steam(360min)）：重启后首个周期不立即采集/提醒
```

- 未触发立即采集、未调用飞书；`/api/health` ok；`/api/admin/tasks` 200
- 下一轮 monitor（60min 后，若仍在 activeHours）为受控重启后首次 → notify=false，**不发送真实 S/A 提醒**

---

## 二、任务 2：TapTap 话题误入"新游"分类回归

### 2.1 根因

`server/feishu/algorithm.mjs` 的 `eventType` 兜底为 `return "新游"`。TapTap 热榜话题（hashtags）来源（`ref-taptap`）的话题帖：
- 无 `facts.taptapEvents`/`haoyouKind`，标题无"版本/更新/活动/联动/赛季/周年"
- 兜底落入"新游"

**真实数据**（修复前）：正式库 111 条 ref-taptap 中"新游上线"含话题内容，如：
- `TapTap玩聚节二轮门票开售`（game=发现好游戏）
- `米哈游大伟哥谈源初之结`（game=源初之结，访谈）
- `# 晴空之下母公司破产清算再度停服`
- `# 阴阳师十周年活动公布`（应为"活动"）

### 2.2 代码改动（server/feishu/algorithm.mjs，两项目一致）

```js
// 新增生命周期信号（活动信号由 eventType 内活动分支先行接管）
const TAP_LIFECYCLE = /上线|定档|首发|公测|内测|开测|删档|不删档|测试|预下载|预约(?:开启|下载|测试|上线)?|开服|发售|开放(?:测试|下载|预约)|正式(?:上线|公测|推出)/iu;
```

```js
// eventType 内、最终 return "新游" 之前新增：
if (sourceId === "ref-taptap") {
  if (/版本|更新|活动|联动|赛季|周年/u.test(`${title} ${facts.haoyouUpdateContent || ""}`)) return "活动";
  if (!TAP_LIFECYCLE.test(title)) return null; // 话题/资讯帖 → 资讯
}
return "新游";
```

行为矩阵：
| 输入（ref-taptap） | 结果 |
|---|---|
| 门票开售 / 访谈 / 停服 / 破产（无生命周期词） | 资讯（null，不进飞书新游/活动） |
| 十周年活动公布 / 2.3 新版本（活动词） | 活动 |
| 定档 / 首发 / 预约 / 不限量测试（生命周期词） | 新游（保持） |
| 有 `facts.taptapEvents`（game-event 详情） | 活动（既有逻辑保持） |

### 2.3 测试（tests/taptap-topic.test.mjs，5 用例：单元 + buildEvents 集成）

- 话题/资讯帖 → null（3 条）
- 活动信号 → 活动（周年活动公布、新版本）
- 真生命周期 → 新游（定档/首发/既有断言不破坏）
- 非 TapTap 来源行为不受影响（好游 update→活动、小七→新游）
- buildEvents 集成：话题行不产生事件；定档行产生新游事件

### 2.4 真实数据验证（正式库只读）

111 条 ref-taptap → **新游 69 / 活动 37 / 资讯 5**（修复前资讯=0）。剩余"新游"均为真生命周期（首发/预约/测试/定档/不限量测试）。

---

## 三、任务 3：Vite 构建不再携带旧 app.js/styles.css

### 3.1 根因

`public/app.js`（54670B）、`public/styles.css`（23542B）经 Vite 默认 `publicDir=public` 在构建时被原样拷入 `dist/`。前端实际只用 `src/` + 根 `index.html`，这两文件是遗留物（api-server 已显式对 `/app.js`、`/styles.css` 返回 404，见下）。

### 3.2 改动

- 删除两项目 `public/app.js`、`public/styles.css`（已确认 src/ 与 index.html 无引用）
- 保留 `public/index.html`（遗留入口，非本次范围）
- `api-server.mjs` 保留 Codex 的 404 拦截（line 288：`/app.js`、`/styles.css` → 404）作为纵深防御

### 3.3 验证（正式项目）

- `npm run build` 后 dist 仅含：`index.html` + `assets/index-BBCxHZKn.js` + `assets/index-CYOx_sWf.css`
- HTTP：`/ → 200`、`/app.js → 404`、`/styles.css → 404`、`/api/health → 200`
- 构建产物含"端游资讯"区块字符串；JS 中无 `app.js`/`styles.css` 引用

---

## 四、测试汇总

| 项目 | 结果 |
|---|---|
| TraeWork 副本 `npm test` | 67/67 通过（30→32 套件，新增 7 用例） |
| 正式项目 `npm test` | 67/67 通过 |
| `node --test tests/scheduler-safe-first.test.mjs` | 4/4 |
| `node --test tests/taptap-topic.test.mjs` | 5/5 |

## 五、文件改动清单（两项目 SHA-256 一致）

| 文件 | 变更 |
|---|---|
| `server/tasks/scheduler.mjs` | 受控重启（safe-first + 首次 monitor 不通知 + main 守卫 + 导出） |
| `server/feishu/algorithm.mjs` | TapTap 话题分类隔离（TAP_LIFECYCLE + ref-taptap 分支） |
| `tests/scheduler-safe-first.test.mjs` | 新增（受控重启 + 日志摘要测试） |
| `tests/taptap-topic.test.mjs` | 新增（分类回归测试） |
| `public/app.js` | 删除（两项目） |
| `public/styles.css` | 删除（两项目） |
| `dist/` | 重建（正式项目），不再含 app.js/styles.css |

另：本轮开始时从正式目录拉取 Codex 最新 12 个文件到工作副本作基线（schema.sql、api-server、feishu/*、src/App.jsx、tests/feishu-sync、public/*），未做内容改动。

## 六、需 Codex 复核/关注的点

1. **回填 2 条游民文章曾按"新游"写入飞书**：旧 scheduler（16:40–18:06）运行期间，把此前回填的《星球大战：银河赛车手》《Trees Hate You》（ref-gamersky）以 `类型=新游` 写入飞书主表。新口径下 gamerSky 应归"资讯"，未来不会作为新事件再入；**已存在的这 2 条飞书记录是否处理由你决定**（本次未删除/修改，遵守红线）。
2. **巫师4 等话题帖 game_name 误解析**：`# 巫师4发售定档` 的 game_name 被解析为"游戏杂谈"（来源解析层问题，非本次分类范围），后续如需可单独处理。
3. **浏览器渲染验证受限**：TRAE Chrome 扩展连接失败（`os error 10061`），页面验证采用 HTTP + 构建产物静态核验；浏览器渲染待扩展可用后补。
4. **下一轮 monitor 行为**：受控重启后首次 monitor（约 60min 后，若在 activeHours）将执行采集 + 飞书增量同步，但 `notify=false` 不发送 S/A 提醒；其后恢复正常通知。
5. **safe-first 为守护默认**：`--no-safe-first` 可关闭；`--once`/`--run <id>` 不受影响（api-server 的手动触发仍即时执行）。

## 七、未完成 / 受限事项

- P1 公网海报（Cloudflare Tunnel）：需凭据/域名，见 `docs/HANDOFF_TO_CODEX_P1P0.md`
- P0 SYSTEM 级开机自启：需管理员权限，见 `docs/HANDOFF_TO_CODEX_P1P0.md`
- 浏览器端页面渲染验证：待 TRAE Chrome 扩展恢复
