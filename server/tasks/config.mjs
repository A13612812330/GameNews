// 统一任务配置层（P1/P4）
// 唯一任务定义来源：/api/admin/tasks 与 scheduler 均从这里读取，禁止前端硬编码。
// 节奏：新游/活动监控 每 1 小时；今日简讯海报 每日 09:30；周报 周一 09:00（过去 14 天）；Steam 快照 每 6 小时。
export const TASKS = [
  {
    id: "monitor",
    name: "新游 / 活动监控",
    rate: "每 1 小时",
    intervalMinutes: 60,
    activeHours: "8:00-23:00",
    desc: "采集来源、清洗内容、跨平台去重后写入统一库。",
    enabled: true,
    kind: "crawl",
  },
  {
    id: "daily-brief",
    name: "今日简讯海报",
    rate: "每日 09:30",
    runAt: { h: 9, m: 30 },
    desc: "从统一库生成今日简讯与海报归档。",
    enabled: true,
    kind: "publish",
  },
  {
    id: "weekly",
    name: "游戏资讯周报",
    rate: "周一 09:00",
    runAt: { weekday: 1, h: 9, m: 0 },
    desc: "统计过去 14 天的新游、活动、Steam 与端游资讯。",
    enabled: true,
    kind: "publish",
  },
  {
    id: "steam",
    name: "Steam 实时快照",
    rate: "每 6 小时",
    intervalMinutes: 360,
    desc: "调用保留的 GameNews 采集器写入实时快照（不重写采集器）。",
    enabled: true,
    kind: "crawl",
  },
  {
    id: "retention",
    name: "轻量留档清理",
    rate: "每日 03:15",
    runAt: { h: 3, m: 15 },
    desc: "保留最近 7 天和未来完整资讯；历史转轻量 JSON，保留飞书与人工评级。",
    enabled: true,
    kind: "maintenance",
  },
];

// 计算任务的最近/下次执行时间（runAt 型按每日/每周推算；interval 型按上次执行+周期推算）。
export function nextRunOf(task, now = new Date(), lastRunAt = null) {
  if (task.runAt) {
    const next = new Date(now);
    next.setHours(task.runAt.h, task.runAt.m, 0, 0);
    if (task.runAt.weekday != null) {
      let d = (task.runAt.weekday - next.getDay() + 7) % 7;
      if (d === 0 && next <= now) d = 7;
      next.setDate(next.getDate() + d);
    } else if (next <= now) {
      next.setDate(next.getDate() + 1);
    }
    return next.toISOString();
  }
  if (task.intervalMinutes) {
    if (!lastRunAt) return now.toISOString(); // 从未运行 → 立即可执行
    const next = new Date(new Date(lastRunAt).getTime() + task.intervalMinutes * 60000);
    return next > now ? next.toISOString() : now.toISOString();
  }
  return null; // 未配置节奏
}

export function taskById(id) {
  return TASKS.find((t) => t.id === id) || null;
}
