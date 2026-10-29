// TapTap 适配器 —— 子进程调用 GameNews 的 fetchHtml + parseList（生产解析器，不重写）
// 页面为动态渲染，GameNews 用浏览器 UA + Firecrawl 兜底；子进程复用其渲染抓取结果。
import { execFile } from "node:child_process";

const GAMENEWS_FETCHER = "E:/新建文件夹/Codex-GPT/GameNews/server/crawler/fetcher.js";
const GAMENEWS_PARSER = "E:/新建文件夹/Codex-GPT/GameNews/server/crawler/parser.js";
const HASHTAGS_URL = "https://www.taptap.cn/forum/hot/hashtags";

// P2/P3 迁入自 GameNews platforms/taptap.js：内容级标题过滤（是否游戏相关资讯），可单测
export function contentFilter(title = "") {
  const value = String(title || "").replace(/\s+/g, " ").trim();
  if (value.length < 8 && !/《[^》]{2,36}》/.test(value)) return false;
  // 排除日历页日期导航（「昨」「明」「01」「20」等纯日期/数字 + 周几）
  if (/^[「【]?(昨|今|明|周[一二三四五六日天]|\d{1,2})[」】]?\s*(周|星期)?[一二三四五六日天]?\s*\d{0,2}$/.test(value)) return false;
  if (/^「?(\d{1,2}|昨|今|明)」?$/.test(value)) return false;
  // 先排除噪音，再判断是否含有资讯信号，避免《游戏名》绕过过滤。
  if (/论坛|讨论|社区|话题|回复|楼主|评分|评分卡|排行|榜单|TOP\s*\d+|合集|热榜|投票|抽奖|开奖|幸运用户|玩家评价|热门标签|猜你喜欢|为你推荐|编辑推荐|攻略|求助|组队|礼包|兑换码|下载|充值|什么时候上线|有人知道|有人不知道|大家有什么问题|萌新|全收集|怎么打/iu.test(value)) return false;
  // 排除行业资讯汇总（很长且含"行业""圈内"等泛词）
  if (value.length > 80 && /行业|圈内|值得关注|汇总|简报|日报|周报/.test(value)) return false;
  // 排除编辑/官方账号简介页
  if (/^TapTap(官方|编辑)/.test(value)) return false;
  // 排除纯用户讨论帖
  if (/^(大家|各位|有人|求助|请教|问一下|讨论|求推荐|求解)/u.test(value)) return false;
  // 必须有游戏名《》或更新公告信号
  const hasBookmark = /《[^》]{2,36}》/.test(value);
  const hasUpdate = /更新公告|版本更新|维护公告|更新预告|停服维护|活动预告|活动公告|新版本|新赛季|新角色|新英雄|联动|上线|开测|公测|定档|首发/;
  if (hasBookmark || hasUpdate.test(value)) return true;
  // 放宽：标题含游戏关键词 + 事件信号
  const hasGame = /游戏|手游|端游|新作|版本/i;
  const hasEvent = /上线|开\w*测试|发布|发售|开启|预告|宣布|公布/;
  if (hasGame.test(value) && hasEvent.test(value)) return true;
  return false;
}

function runCapture(script) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ["--input-type=module", "-e", script], {
      timeout: 60000, maxBuffer: 12 * 1024 * 1024,
      cwd: "E:/新建文件夹/Codex-GPT/GameNews",
    }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message || "").slice(0, 500)));
      try {
        const json = stdout.slice(stdout.indexOf("{"));
        resolve(JSON.parse(json));
      } catch (e) { reject(new Error(`TapTap 采集结果解析失败: ${e.message}`)); }
    });
  });
}

// 热榜话题（前 5）
export async function fetchTapTapHashtags() {
  const script = `
    import { fetchHtml } from ${JSON.stringify(`file:///${GAMENEWS_FETCHER.replace(/\\/g, "/")}`)};
    import { parseList } from ${JSON.stringify(`file:///${GAMENEWS_PARSER.replace(/\\/g, "/")}`)};
    const url = ${JSON.stringify(HASHTAGS_URL)};
    const platform = { id: "ref-taptap", name: "TapTap", category: "手游", urlType: "hashtags" };
    const html = await fetchHtml(url, { dynamic: true });
    const items = parseList(html, platform, url);
    console.log(JSON.stringify({ items }));
  `;
  const payload = await runCapture(script);
  const SSR_ARTIFACT = /<!---->|data-v-[0-9a-f]+|itemprop=|class=["']|style=["']|<\/?\w|^[\d:[\]{},]+$/;
  const out = (payload.items || [])
    .map((it) => ({
      legacy: `taptap:${it.detailUrl || ""}`,
      title: it.title || "", gameName: it.gameName || "",
      detailUrl: it.detailUrl || "", imageUrl: it.imageUrl || "",
      dateText: it.dateText || "", paragraphs: it.paragraphs || [],
      category: it.category || "游戏热点话题", score: it.score || 60,
      facts: it.facts || {},
    }))
    // 内容级过滤：非游戏资讯（讨论/攻略/日期导航等）直接剔除
    .filter((it) => contentFilter(it.title))
    // TapTap CDN 偶发返回 SSR 空壳：过滤模板残留/结构片段，宁缺毋滥
    .filter((it) => !SSR_ARTIFACT.test(`${it.title} ${it.gameName}`));
  return { items: out, error: "" };
}
