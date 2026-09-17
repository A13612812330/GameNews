import React, { Suspense, lazy, useEffect, useState } from "react";
import { AppShell } from "./components/AppShell.jsx";
import { LoadingScreen, ErrorBoundary } from "./components/ui.jsx";

const FeedPage = lazy(() => import("./pages/FeedPage.jsx"));
const BriefPage = lazy(() => import("./pages/BriefPage.jsx"));
const DashboardPage = lazy(() => import("./pages/DashboardPage.jsx"));
const CrawlerMonitorPage = lazy(() => import("./pages/CrawlerMonitorPage.jsx"));

const pages = { dash: DashboardPage, feed: FeedPage, brief: BriefPage, crawler: CrawlerMonitorPage };
const PAGE_TITLES = { dash: "今日简讯", feed: "抓取资讯", brief: "简讯编辑", crawler: "爬虫监控" };

function readRoute() {
  const route = window.location.hash.replace(/^#\/?/, "");
  return pages[route] ? route : "dash";
}

export function App() {
  const [route, setRoute] = useState(readRoute);

  useEffect(() => {
    const onHashChange = () => setRoute(readRoute());
    window.addEventListener("hashchange", onHashChange);
    if (!window.location.hash) window.location.hash = "#/dash";
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    document.title = `${PAGE_TITLES[route] || "GameNews"} · 游戏资讯工作台`;
  }, [route]);

  if (!pages[route]) {
    return (
      <AppShell route={route}>
        <div style={{textAlign:"center",padding:"60px 20px"}}>
          <h2 style={{marginBottom:12}}>页面未找到</h2>
          <p style={{color:"var(--muted)",marginBottom:16}}>访问的路径不存在</p>
          <button className="btn btn-primary" onClick={() => { window.location.hash = "#/dash"; }}>回到首页</button>
        </div>
      </AppShell>
    );
  }

  const Page = pages[route];

  return (
    <AppShell route={route}>
      <Suspense fallback={<LoadingScreen />}>
        <ErrorBoundary>
          <Page />
        </ErrorBoundary>
      </Suspense>
    </AppShell>
  );
}
