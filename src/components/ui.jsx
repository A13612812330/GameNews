import React, { Component } from "react";
import { LoaderCircle } from "lucide-react";

export function LoadingScreen() {
  return (
    <div className="loading-screen">
      <LoaderCircle className="spin" size={20} style={{ color: "var(--pine)" }} />
    </div>
  );
}

export function PageHeader({ eyebrow, title, description }) {
  return (
    <header className="page-header">
      {eyebrow && <span className="page-eyebrow">{eyebrow}</span>}
      <h1>{title}</h1>
      {description && <p>{description}</p>}
    </header>
  );
}

export function StatusBadge({ quality }) {
  const map = {
    verified:    ["质量可靠", "badge-green"],
    ok:          ["可用", "badge-green"],
    needs_review: ["待审核", "badge-amber"],
    low:         ["低质", "badge-rose"],
    low_quality:  ["低质量", "badge-rose"],
    failed:       ["抓取失败", "badge-rose"],
    pending:      ["待抓取", "badge-neutral"],
  };
  const [label, cls] = map[quality] || ["未知", "badge-neutral"];
  return <span className={`badge ${cls}`}>{label}</span>;
}

export function StatCard({ value, label }) {
  return (
    <div className="stat-card">
      <div className="stat-card-value">{value}</div>
      <div className="stat-card-label">{label}</div>
    </div>
  );
}

export function Toast({ message, onClose }) {
  if (!message) return null;
  return (
    <div className="toast" role="status" onClick={onClose}>
      {message}
    </div>
  );
}

export function SkeletonLine({ width = "100%", height = 12, inline = false }) {
  return (
    <div className="skeleton" style={{ width, height, display: inline ? "inline-block" : "block" }} />
  );
}

export function SkeletonArticleRow() {
  return (
    <div className="skeleton-row">
      <div className="skeleton" style={{ width: 14, height: 14, borderRadius: 3, flexShrink: 0 }} />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
        <div className="skeleton skeleton-bar" style={{ width: "65%" }} />
        <div className="skeleton skeleton-bar" style={{ width: "35%" }} />
      </div>
      <div className="skeleton" style={{ width: 44, height: 3, borderRadius: 2 }} />
      <div className="skeleton" style={{ width: 52, height: 18, borderRadius: 9 }} />
    </div>
  );
}

export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() { return { hasError: true }; }
  render() {
    if (this.state.hasError) {
      return (
        <div className="error-boundary">
          <h2>页面加载异常</h2>
          <p>请尝试刷新页面，或联系开发者。</p>
          <button onClick={() => { this.setState({ hasError: false }); window.location.reload(); }}>
            刷新页面
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
