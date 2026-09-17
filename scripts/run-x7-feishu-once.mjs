import { crawlCandidates, crawlDetails } from "../server/crawler/tasks.js";
import { syncFeishuTopicMonitorForSource } from "../server/feishuTopicMonitor.js";

const result = await crawlCandidates(["ref-x7"], { urlTypes: ["x7"] });
const ids = result.flatMap((group) => group.candidates || []).map((item) => item.id).filter(Boolean);
const details = ids.length ? await crawlDetails(ids) : { success: 0, failed: 0 };
const feishu = await syncFeishuTopicMonitorForSource("ref-x7");
console.log(JSON.stringify({
  mode: "x7-feishu-only",
  candidates: ids.length,
  details,
  feishu,
}, null, 2));
