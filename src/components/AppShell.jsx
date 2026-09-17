import React from "react";
import {
  Radar, FileEdit, Sparkles, LoaderCircle, Sun, Moon, LayoutDashboard, Activity, ImageDown, CalendarDays,
} from "lucide-react";
import { articleStore } from "../services/articleStore.js";
import { getBriefPreferences } from "../services/briefPreferences.js";
import { api } from "../services/api.js";
import { briefHtmlExportPayload, downloadRemoteFile } from "../utils/export.js";
import { Toast } from "./ui.jsx";

const NAV_ITEMS = [
  { id: "dash",  label: "今日简讯", icon: LayoutDashboard, path: "#/dash",  desc: "阅读" },
  { id: "feed",  label: "抓取资讯", icon: Radar,    path: "#/feed",  desc: "抓取" },
  { id: "brief", label: "简讯编辑", icon: FileEdit, path: "#/brief", desc: "编辑" },
  { id: "crawler", label: "爬虫监控", icon: Activity, path: "#/crawler", desc: "状态" },
];

export function AppShell({ route, children }) {
  const [busy, setBusy] = React.useState(false);
  const [posterBusy, setPosterBusy] = React.useState(false);
  const [toast, setToast] = React.useState("");
  const [posterResult, setPosterResult] = React.useState(null);
  const [weeklyBusy, setWeeklyBusy] = React.useState(false);
  const [weeklyResult, setWeeklyResult] = React.useState(null);
  const [dark, setDark] = React.useState(() => localStorage.getItem("theme") === "dark");
  const [apiOnline, setApiOnline] = React.useState(true);

  React.useEffect(() => {
    api.health().then(() => setApiOnline(true)).catch(() => setApiOnline(false));
    const timer = setInterval(() => {
      api.health().then(() => setApiOnline(true)).catch(() => setApiOnline(false));
    }, 30000);
    return () => clearInterval(timer);
  }, []);

  React.useEffect(() => {
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    localStorage.setItem("theme", dark ? "dark" : "light");
  }, [dark]);

  const go = (path) => { window.location.hash = path; };

  const autoGenerate = async () => {
    setBusy(true);
    try {
      const preferences = getBriefPreferences();
      const selectedIds = articleStore.getSelected();
      // 未手选时直接复用 Dashboard 最终投影，避免再以旧规则从数据库二次选材。
      const dashboard = selectedIds.length ? null : await api.dashboard();
      const automaticIds = dashboard?.projection?.selectedArticleIds || [];
      const top = selectedIds.length ? selectedIds : automaticIds;
      if (!top.length) { setToast("暂无符合条件的候选资讯"); return; }
      if (!window.confirm(`将按今日简讯当前展示规则生成 ${top.length} 条资讯，并进入简讯编辑，继续？`)) return;
      if (!selectedIds.length) articleStore.setSelected(top);
      const result = await api.generateBrief({
        articleIds: top,
        style: preferences.style,
        maxLength: preferences.maxLen,
        contentMode: preferences.contentMode,
        imagesPerArticle: preferences.imagesPerArticle,
      });
      const draft = result.brief;
      const exported = await api.saveBrief({ ...draft, status: "exported" });
      const finalDraft = exported.brief || draft;
      sessionStorage.setItem("gamenews:generated-brief", JSON.stringify(finalDraft));
      // 当用户已经停留在简讯编辑页时，hash 不会变化，页面不会重新挂载。
      // 事件保证草稿立即进入编辑器；其他页面仍由 sessionStorage 在挂载时接收。
      window.dispatchEvent(new CustomEvent("gamenews:brief-generated", { detail: finalDraft }));
      const output = await api.exportBriefHtml(briefHtmlExportPayload(finalDraft));
      downloadRemoteFile(output.downloadUrl, output.fileName);
      setToast(`已生成 ${top.length} 条简讯：${output.fileName}`);
      setTimeout(() => go("#/brief"), 700);
    } catch (e) {
      setToast("自动生成失败：" + e.message);
    } finally {
      setBusy(false);
      setTimeout(() => setToast(""), 3000);
    }
  };

  const generatePoster = async () => {
    const selected = articleStore.getSelected();
    setPosterBusy(true);
    try {
      // 未手动勾选时由服务端按上海自然日补齐今日资讯；手动勾选仍优先。
      const result = await api.generateDailyPoster(selected.length ? { articleIds: selected } : {});
      downloadRemoteFile(result.downloadUrl, result.fileName);
      setPosterResult(result);
      setToast(`海报已生成：${result.fileName}`);
    } catch (e) {
      setToast("海报生成失败：" + e.message);
    } finally {
      setPosterBusy(false);
      setTimeout(() => setToast(""), 4200);
    }
  };

  const generateWeeklyPoster = async () => {
    setWeeklyBusy(true);
    try {
      const result = await api.generateWeeklyPoster();
      downloadRemoteFile(result.downloadUrl, result.fileName);
      setWeeklyResult(result);
      setToast(`周报已生成并开始下载：${result.fileName}`);
    } catch (e) {
      setToast("周报生成失败：" + e.message);
    } finally {
      setWeeklyBusy(false);
      setTimeout(() => setToast(""), 4200);
    }
  };

  return (
    <div className="app-root">
      <div className="mobile-topbar">
        <div className="mobile-brand"><span className="sidebar-brand-icon">GN</span><strong>今日简讯</strong></div>
        <div className="mobile-nav-links">
          {NAV_ITEMS.map((item) => (
            <button key={item.id} className={`mobile-nav-item ${route === item.id ? "is-current" : ""}`} onClick={() => go(item.path)}>
              <item.icon size={14} /><span>{item.label}</span>
            </button>
          ))}
        </div>
        <button className="mobile-theme-btn" onClick={() => setDark(!dark)} aria-label={dark ? "切换到亮色主题" : "切换到暗色主题"}>
          {dark ? <Sun size={15} /> : <Moon size={15} />}
        </button>
      </div>
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="sidebar-brand-icon">GN</div>
          <div>
            <div className="sidebar-brand-text">资讯工作台</div>
            <span className="sidebar-brand-sub">Game News Hub</span>
          </div>
        </div>
        <nav className="sidebar-nav">
          <span className="nav-group-label">核心功能</span>
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${route === item.id ? "is-current" : ""}`}
              onClick={() => go(item.path)}
              aria-current={route === item.id ? "page" : undefined}
            >
              <item.icon size={15} />
              <span>{item.label}</span>
              <span className="nav-item-desc">{item.desc}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <button
            className="btn btn-full"
            style={{ marginBottom: 5, justifyContent: "center", fontSize: 10 }}
            onClick={() => setDark(!dark)}
            aria-pressed={dark}
            title={dark ? "切换到亮色主题" : "切换到暗色主题"}
          >
            {dark ? <Sun size={12} /> : <Moon size={12} />}
            {dark ? "亮色" : "暗色"}
          </button>
          <div className="sidebar-generate-actions">
            <button
              className="btn btn-primary btn-full"
              onClick={autoGenerate}
              disabled={busy}
              title="按今日简讯当前展示规则生成可编辑简讯"
            >
              {busy ? <LoaderCircle className="spin" size={12} /> : <Sparkles size={12} />}
              生成简讯
            </button>
            <button
              className="btn btn-secondary btn-full"
              onClick={generatePoster}
              disabled={posterBusy}
              title="按抓取资讯中已选择的条目生成今日海报"
            >
              {posterBusy ? <LoaderCircle className="spin" size={12} /> : <ImageDown size={12} />}
              生成海报
            </button>
            <button
              className="btn btn-secondary btn-full"
              onClick={generateWeeklyPoster}
              disabled={weeklyBusy}
              title="按本周素材快照生成并下载长海报周报"
            >
              {weeklyBusy ? <LoaderCircle className="spin" size={12} /> : <CalendarDays size={12} />}
              生成周报
            </button>
          </div>
          {posterResult?.url ? (
            <a
              className="sidebar-generated-file"
              href={`http://127.0.0.1:64424${posterResult.url}`}
              target="_blank"
              rel="noreferrer"
            >
              打开刚生成的海报
            </a>
          ) : null}
          {weeklyResult?.url ? (
            <a className="sidebar-generated-file" href={`http://127.0.0.1:64424${weeklyResult.url}`} target="_blank" rel="noreferrer">打开刚生成的周报</a>
          ) : null}
          <div className="sidebar-status">
            <span className={`status-dot ${apiOnline ? "live" : ""}`} style={{ background: apiOnline ? "" : "#e06060" }} />
            {apiOnline ? "服务运行中" : "服务离线"}
          </div>
        </div>
      </aside>
      <main className="main-content">
        {children}
        <Toast message={toast} onClose={() => setToast("")} />
      </main>
    </div>
  );
}
