import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { spawn } from "node:child_process";

const BACKEND_ORIGIN = "http://127.0.0.1:64424";

function localBackendRecovery() {
  let starting = null;
  const isLocalRequest = (request) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress);
  const writeJson = (response, status, body) => {
    response.statusCode = status;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify(body));
  };
  const health = async () => {
    try {
      const response = await fetch(`${BACKEND_ORIGIN}/api/health`, { signal: AbortSignal.timeout(1200) });
      return response.ok;
    } catch { return false; }
  };
  const waitForHealth = async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (await health()) return true;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return false;
  };
  const recover = async () => {
    if (await health()) return { started: false, ready: true };
    if (!starting) {
      starting = (async () => {
        // 仅本机开发服务调用；独立启动并脱离 Vite 进程，避免页面热更新误杀后端。
        const child = spawn(process.execPath, ["server/index.js"], {
          cwd: process.cwd(),
          detached: true,
          stdio: "ignore",
          windowsHide: true,
          env: { ...process.env, GAME_NEWS_API_PORT: "64424" },
        });
        child.unref();
        return { started: true, ready: await waitForHealth() };
      })().finally(() => { starting = null; });
    }
    return starting;
  };
  return {
    name: "gamenews-local-backend-recovery",
    configureServer(server) {
      server.middlewares.use("/__local/recover-backend", async (request, response) => {
        if (request.method !== "POST") return writeJson(response, 405, { ok: false, message: "仅支持 POST" });
        if (!isLocalRequest(request)) return writeJson(response, 403, { ok: false, message: "仅允许本机调用" });
        try {
          const result = await recover();
          return writeJson(response, result.ready ? 200 : 503, {
            ok: result.ready,
            started: result.started,
            message: result.ready ? (result.started ? "后端已恢复" : "后端正常") : "后端启动超时，请检查服务日志",
          });
        } catch (error) {
          return writeJson(response, 503, { ok: false, message: error.message || "后端恢复失败" });
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), localBackendRecovery()],
  server: {
    host: "127.0.0.1",
    port: 64423,
    proxy: {
      "/api": "http://127.0.0.1:64424",
      "/crawler-assets": "http://127.0.0.1:64424",
    },
  },
  build: { outDir: "dist" },
});
