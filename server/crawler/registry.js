import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE_FILE = path.join(root, "data", "crawler", "sources.json");

export const PLATFORMS = Object.freeze([
  { id:"ref-haoyou", name:"好游快爆", category:"手游",
    urls:[
      {url:"https://www.3839.com/timeline.html", type:"timeline", label:"时间线"},
    ], enabled:true, fixed:true },
  { id:"ref-taptap", name:"TapTap", category:"手游",
    urls:[
      {url:"https://www.taptap.cn/forum/hot/hashtags", type:"hashtags", label:"热榜话题"},
      {url:"https://www.taptap.cn/upcoming", type:"upcoming", label:"即将上线"},
      {url:"https://www.taptap.cn/app-calendar", type:"appCalendar", label:"新游日历"},
      {url:"https://www.taptap.cn/top/download/new", type:"newDownloads", label:"新品榜（今日）"},
      {url:"https://www.taptap.cn/top/in-app-event-reserve", type:"eventReserve", label:"新版本"},
    ], enabled:true, fixed:true },
  { id:"ref-x7", name:"小七", category:"手游",
    urls:[{url:"https://www.x7sy.com/reserve", type:"x7", label:"新游预约"}], enabled:true, fixed:true, monitorOnly:true },
  { id:"ref-gamersky", name:"游民星空", category:"端游",
    urls:[{url:"https://www.gamersky.com/news/", type:"gamersky", label:"资讯"}], enabled:true, fixed:true },
  { id:"ref-gcores", name:"机核", category:"资讯",
    urls:[{url:"https://www.gcores.com/news", type:"gcores", label:"资讯"}], enabled:true, fixed:true },
  { id:"ref-steam", name:"Steam", category:"端游",
    urls:[{url:"https://store.steampowered.com/api/featuredcategories", type:"api", label:"新品"}], enabled:true, fixed:true },
]);

async function readJson(p, fb) { try { return JSON.parse(await fs.readFile(p,"utf-8")) } catch { return fb } }
async function writeJson(p, d) { await fs.mkdir(path.dirname(p),{recursive:true}); await fs.writeFile(p,JSON.stringify(d,null,2)) }

export async function getSources() {
  const custom = await readJson(SOURCE_FILE, []);
  return [...PLATFORMS, ...custom.filter(c => !PLATFORMS.some(p => p.id === c.id))];
}

export function getPlatform(id) { return PLATFORMS.find(p => p.id === id) || null; }

export async function addCustomSource(s) {
  const c = await readJson(SOURCE_FILE, []);
  if (PLATFORMS.find(p => p.id === s.id) || c.find(x => x.id === s.id)) throw new Error(`来源 "${s.id}" 已存在`);
  const e = { ...s, fixed:false, enabled:true };
  c.push(e); await writeJson(SOURCE_FILE, c); return e;
}

export async function updateCustomSource(id, patch) {
  const c = await readJson(SOURCE_FILE, []);
  const i = c.findIndex(x => x.id === id);
  if (i === -1) throw new Error(`自定义来源 "${id}" 不存在`);
  c[i] = { ...c[i], ...patch, id };
  await writeJson(SOURCE_FILE, c); return c[i];
}

export async function removeCustomSource(id) {
  const c = await readJson(SOURCE_FILE, []);
  const f = c.filter(x => x.id !== id);
  if (f.length === c.length) throw new Error(`自定义来源 "${id}" 不存在`);
  await writeJson(SOURCE_FILE, f);
}
