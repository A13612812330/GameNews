import React, { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Ban,
  CheckCircle2,
  ExternalLink,
  FileText,
  History,
  ImageIcon,
  Layers3,
  LoaderCircle,
  Play,
  PauseCircle,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { api } from "../services/api.js";
import "../crawler-monitor.css";

function formatTime(value) {
  if (!value) return "—";
  const time = new Date(value);
  return Number.isNaN(time.getTime())
    ? String(value)
    : time.toLocaleString("zh-CN", { hour12: false });
}

function percentage(part, whole) {
  if (!whole) return "—";
  return `${Math.round((part / whole) * 100)}%`;
}

function SourceCard({
  source,
  paused,
  progress = [],
  liveSource,
  onUpdate,
  updating,
}) {
  const detailRate = percentage(source.detailCount, source.total);
  const imageRate = percentage(source.imageCount, source.total);
  const running = progress.some((item) => item.status === "running");
  const failed = progress.some((item) => item.status === "failed");
  const completed = progress.length > 0 && !running && !failed;
  const stateLabel = running
    ? "抓取中"
    : failed
      ? "存在失败"
      : completed
        ? "本轮完成"
        : paused
          ? "已暂停"
          : "等待本轮";
  return (
    <article
      className={`crawler-source-card ${paused ? "is-paused" : ""} ${running ? "is-running" : ""} ${failed ? "is-failed" : ""}`}
    >
      <div className="crawler-source-card-head">
        <div>
          <span className="crawler-source-status" />
          <strong>{source.sourceName}</strong>
          <small className="crawler-source-run-state">{stateLabel}</small>
        </div>
        <a
          href={source.sourceUrl}
          target="_blank"
          rel="noreferrer"
          title={`打开 ${source.sourceName} 原始入口`}
        >
          <ExternalLink size={14} />
        </a>
      </div>
      <p>{source.rule}</p>
      <div className="crawler-table-pills">
        {(source.tables || []).map((table) => (
          <span key={table.name}>
            {table.name}
            <b>{table.count}</b>
          </span>
        ))}
      </div>
      <dl className="crawler-source-coverage">
        <div>
          <dt>可见</dt>
          <dd>{source.total}</dd>
        </div>
        <div>
          <dt>正文</dt>
          <dd>{detailRate}</dd>
        </div>
        <div>
          <dt>图片</dt>
          <dd>{imageRate}</dd>
        </div>
        <div>
          <dt>本轮写入</dt>
          <dd>{liveSource?.writtenCount ?? 0}</dd>
        </div>
      </dl>
      <button
        className="crawler-source-action"
        onClick={() => {
          if (
            window.confirm(
              `将更新「${source.sourceName}」候选，并补全详情、图片、RAW 验收页与当日归档。是否继续？`,
            )
          )
            onUpdate(source);
        }}
        disabled={paused || updating}
        title={paused ? "爬虫暂停时不能更新候选" : `更新 ${source.sourceName} 并补全详情与图片`}
      >
        {updating ? <LoaderCircle className="spin" size={12} /> : <RotateCcw size={12} />}
        更新该来源
      </button>
    </article>
  );
}

export default function CrawlerMonitorPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [operation, setOperation] = useState("");
  const [operationNote, setOperationNote] = useState("");
  const [error, setError] = useState("");

  const load = async (quiet = false) => {
    quiet ? setRefreshing(true) : setLoading(true);
    try {
      const result = await api.crawlMonitor();
      if (!result.raw)
        throw new Error("后端仍在使用旧监控接口；请重启 64424 后端服务");
      setData(result);
      setError("");
    } catch (e) {
      setError(e.message || "监控数据读取失败");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    load();
    const timer = window.setInterval(() => load(true), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const runCandidates = async (sourceIds = [], label = "更新全部候选") => {
    setOperation(sourceIds.length ? sourceIds[0] : "all");
    setOperationNote(`${label}中：正在写入候选列表…`);
    setError("");
    try {
      const result = await api.crawlCandidates(sourceIds);
      const count = (result.results || []).reduce(
        (sum, item) => sum + (item.count || 0),
        0,
      );
      setOperationNote(
        `${label}完成：${count} 条候选、详情与图片已处理，RAW 已同步 ${result.raw?.total || 0} 条。`,
      );
      await load(true);
    } catch (e) {
      setError(e.message || `${label}失败`);
      setOperationNote("");
    } finally {
      setOperation("");
    }
  };

  const syncRaw = async () => {
    setOperation("raw");
    setOperationNote("正在从当前数据库重建 RAW 参考页…");
    setError("");
    try {
      const result = await api.refreshRaw();
      setOperationNote(
        `RAW 已同步：${result.raw?.total || 0} 条可见资讯，${result.raw?.hidden || 0} 条已过滤。`,
      );
      await load(true);
    } catch (e) {
      setError(e.message || "RAW 同步失败");
      setOperationNote("");
    } finally {
      setOperation("");
    }
  };

  const raw = data?.raw || {};
  const monitor = data?.monitor || {};
  const sourceTotals = useMemo(
    () =>
      (raw.sources || []).reduce(
        (result, source) => ({
          details: result.details + (source.detailCount || 0),
          images: result.images + (source.imageCount || 0),
        }),
        { details: 0, images: 0 },
      ),
    [raw.sources],
  );
  const pause = monitor.pause || { paused: false, message: "", since: null };
  const live = data?.live || { totalWrites: 0, sources: [] };
  const liveProgress = monitor.sourceProgress || [];
  const lastRunProgress = monitor.history?.at(-1)?.sourceProgress || [];
  const progress = liveProgress.length ? liveProgress : lastRunProgress;
  const progressBySource = useMemo(() => {
    const map = new Map();
    progress.forEach((item) => {
      const entries = map.get(item.sourceId) || [];
      entries.push(item);
      map.set(item.sourceId, entries);
    });
    return map;
  }, [progress]);
  const liveBySource = useMemo(
    () =>
      new Map((live.sources || []).map((source) => [source.sourceId, source])),
    [live.sources],
  );
  const statusLabel = monitor.active
    ? "抓取运行中"
    : pause.paused
      ? "维护暂停（规则已固定）"
      : "等待抓取";
  const statusNote = monitor.active
    ? monitor.operation || "正在处理当前任务"
    : pause.paused
      ? pause.message || "按项目约定，当前不执行候选与详情抓取"
      : "当前没有运行中的抓取任务";

  if (loading && !data)
    return (
      <div className="crawler-monitor-loading">
        <LoaderCircle className="spin" size={22} />
        正在读取 RAW 监控快照…
      </div>
    );
  if (error && !data)
    return (
      <div className="crawler-monitor-empty">
        <p>{error}</p>
        <button className="btn btn-primary" onClick={() => load()}>
          <RefreshCw size={13} />
          重试
        </button>
      </div>
    );

  return (
    <div className="crawler-monitor-page">
      <header className="crawler-monitor-hero">
        <span>采集运行台</span>
        <h1>爬虫监控</h1>
        <p>查看抓取是否完成、数据何时更新，以及各来源在当前业务时间范围内的覆盖情况。</p>
      </header>

      <section
        className={`crawler-state-strip ${monitor.active ? "is-active" : pause.paused ? "is-paused" : ""}`}
      >
        <div className="crawler-state-symbol">
          {monitor.active ? (
            <Activity size={20} />
          ) : pause.paused ? (
            <PauseCircle size={20} />
          ) : (
            <CheckCircle2 size={20} />
          )}
        </div>
        <div className="crawler-state-copy">
          <strong>{statusLabel}</strong>
          <span>{statusNote}</span>
        </div>
        <div className="crawler-state-meta">
          <span>
            {monitor.active
              ? "本轮写入"
              : raw.stale
                ? "数据快照待更新"
                : "数据快照"}
          </span>
          <b>
            {monitor.active
              ? `${live.totalWrites || 0} 条本轮写入`
              : raw.ageMinutes == null
                ? "—"
                : `${raw.ageMinutes} 分钟前`}
          </b>
          <small>
            {monitor.active
              ? "当前任务结束后会自动更新快照"
              : raw.generatedAt
                ? `生成于 ${formatTime(raw.generatedAt)}`
                : "尚未生成数据快照"}
          </small>
        </div>
        <button
          className="btn btn-secondary"
          onClick={() => load(true)}
          disabled={refreshing}
        >
          {refreshing ? (
            <LoaderCircle className="spin" size={13} />
          ) : (
            <RefreshCw size={13} />
          )}
          刷新状态
        </button>
      </section>

      {error ? <div className="crawler-inline-error">{error}</div> : null}

      <section className="crawler-console" aria-label="手动操作台">
        <div className="crawler-console-heading">
          <div>
            <span>编辑部操作台</span>
            <strong>手动更新会同步补全详情与图片</strong>
          </div>
          <small>
            候选、详情和图片会按同一规则写入 SQLite；随后同步 RAW 验收页。
          </small>
        </div>
        <div className="crawler-console-actions">
          <button
            className="btn btn-primary crawler-primary-action"
            onClick={() => runCandidates([], "更新全部候选")}
            disabled={Boolean(operation) || monitor.active || pause.paused}
          >
            {operation === "all" ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />}
            更新全部候选
          </button>
          <button
            className="btn btn-secondary"
            onClick={syncRaw}
            disabled={Boolean(operation) || monitor.active}
          >
            {operation === "raw" ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}
            同步 RAW 预览
          </button>
          <a className="crawler-feed-link" href="#/feed">
            前往抓取资讯选择详情 <ExternalLink size={13} />
          </a>
        </div>
        {operationNote ? <p className="crawler-operation-note">{operationNote}</p> : null}
      </section>

      <section className="crawler-overview-grid" aria-label="RAW 概览">
        <div className="crawler-overview-card">
          <Layers3 size={16} />
          <div>
            <strong>{raw.total || 0}</strong>
            <span>抓取资讯可见（含 Steam 近 7 日窗口）</span>
          </div>
        </div>
        <div className="crawler-overview-card is-filtered">
          <Ban size={16} />
          <div>
            <strong>{raw.auditTotal || raw.total || 0}</strong>
            <span>RAW 验收全量（含历史）</span>
          </div>
        </div>
        <div className="crawler-overview-card">
          <FileText size={16} />
          <div>
            <strong>{percentage(sourceTotals.details, raw.total)}</strong>
            <span>{sourceTotals.details} 条有正文</span>
          </div>
        </div>
        <div className="crawler-overview-card">
          <ImageIcon size={16} />
          <div>
            <strong>{percentage(sourceTotals.images, raw.total)}</strong>
            <span>{sourceTotals.images} 条有图片</span>
          </div>
        </div>
      </section>

      <section className="crawler-live-summary" aria-label="本轮抓取结果">
        <div>
              <span>最近抓取结果</span>
          <strong>{live.totalWrites || 0}</strong>
          <small>
            {live.since
              ? `本轮开始于 ${formatTime(live.since)}`
              : "本服务周期尚未执行抓取"}
          </small>
        </div>
        <p>
          表示最近一轮实际写入数据库的数量；手动更新和定时任务都会补详情、图片、清理旧文章，再同步数据快照。
        </p>
      </section>

      <section className="crawler-progress-panel">
        <div className="crawler-panel-title">
          <div>
            <span>本轮来源进度</span>
            <strong>{monitor.active ? "实时抓取进度" : "最近抓取结果"}</strong>
          </div>
          <b>{progress.length || 0} 个来源入口</b>
        </div>
        <div className="crawler-progress-list">
          {progress.length ? (
            progress.map((item) => (
              <div
                className={`crawler-progress-row is-${item.status}`}
                key={item.key}
              >
                <span className="crawler-progress-dot" />
                <b>{item.sourceName}</b>
                <small>{item.urlType}</small>
                <span>
                  {item.status === "running"
                    ? "抓取中"
                    : item.status === "failed"
                      ? item.error || "失败"
                      : `完成 · ${item.count || 0} 条`}
                </span>
              </div>
            ))
          ) : (
            <p className="crawler-panel-empty">
              尚未有本次服务周期内的抓取进度。
            </p>
          )}
        </div>
      </section>

      <section className="crawler-section-heading">
        <div>
          <span>当前规则分表</span>
          <h2>来源规则与参考覆盖</h2>
        </div>
        <p>
          覆盖率与抓取资讯页同一口径：{raw.scopeLabel || "今日 + 未来"}。RAW 全量用于规则验收，当前为 {raw.auditTotal || raw.total || 0} 条，其中已过滤 {raw.hidden || 0} 条。
        </p>
      </section>
      <div className="crawler-source-grid">
        {(raw.sources || []).map((source) => (
          <SourceCard
            key={source.sourceId}
            source={source}
            paused={pause.paused}
            progress={progressBySource.get(source.sourceId) || []}
            liveSource={liveBySource.get(source.sourceId)}
            onUpdate={(item) => runCandidates([item.sourceId], `更新 ${item.sourceName}`)}
            updating={operation === source.sourceId || monitor.active}
          />
        ))}
      </div>

      <div className="crawler-bottom-grid">
        <section className="crawler-panel crawler-latest-panel">
          <div className="crawler-panel-title">
            <div>
              <span>最新写入</span>
              <strong>数据快照内容</strong>
            </div>
            <b>{raw.latest?.length || 0} 条</b>
          </div>
          <div className="crawler-latest-list">
            {(raw.latest || []).length ? (
              raw.latest.map((article) => (
                <div className="crawler-latest-row" key={article.id}>
                  <span
                    className="crawler-latest-dot"
                    data-source={article.sourceName}
                  />
                  <div>
                    <b>{article.gameName || "未识别游戏"}</b>
                    <p>{article.title}</p>
                    <small>
                      {article.sourceName} · {article.table} ·{" "}
                      {formatTime(article.discoveredAt)}
                    </small>
                  </div>
                </div>
              ))
            ) : (
              <p className="crawler-panel-empty">本次快照没有可展示的条目。</p>
            )}
          </div>
        </section>

        <section className="crawler-panel crawler-history-panel">
          <div className="crawler-panel-title">
            <div>
              <span>运行轨迹</span>
              <strong>抓取记录</strong>
            </div>
            <b>{monitor.history?.length || 0} 次</b>
          </div>
          <p className="crawler-history-note">
            每行是一轮手动或定时抓取：可核对完成时间、涉及入口数和最终状态；失败任务会标红保留。
          </p>
          <div className="crawler-history-list">
            {(monitor.history || []).length ? (
              monitor.history
                .slice()
                .reverse()
                .slice(0, 7)
                .map((run, index) => (
                  <div key={`${run.startedAt}-${index}`}>
                    <time>{formatTime(run.finishedAt || run.startedAt)}</time>
                    <span>
                      {run.operation || "抓取任务"} ·{" "}
                      {run.sourceProgress?.length || 0} 个入口
                    </span>
                    <b className={run.stage === "failed" ? "is-failed" : ""}>
                      {run.stage === "failed" ? "失败" : "完成"}
                    </b>
                  </div>
                ))
            ) : (
              <p className="crawler-panel-empty">
                {pause.paused
                  ? "维护暂停中，暂无新的抓取阶段记录。"
                  : "尚未完成可记录的抓取任务。"}
              </p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
