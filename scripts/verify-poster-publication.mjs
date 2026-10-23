import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const archive = path.join(root, "published-posters");
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/u,
  /\b(?:app_secret|client_secret|FEISHU\w*SECRET|access_token|refresh_token)\b["']?\s*[:=]\s*["'][A-Za-z0-9_\-]{16,}["']/iu,
  /https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9-]+/iu,
];
const forbidden = /(?:^|\/)(?:\.env(?:\.[^/]+)?|[^/]+\.(?:sqlite|sqlite3|db|key|secret|pem))$/iu;
const issues = [];
let files = 0;
let textFiles = 0;

function visit(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const relative = path.relative(root, full).replaceAll("\\", "/");
    if (entry.isSymbolicLink()) { issues.push(`${relative}: symbolic link`); continue; }
    if (entry.isDirectory()) { visit(full); continue; }
    files += 1;
    if (forbidden.test(relative)) issues.push(`${relative}: forbidden file type`);
    if (/\.(?:html?|json|md|txt|csv|js|mjs|ps1|vbs)$/iu.test(entry.name)) {
      textFiles += 1;
      const text = fs.readFileSync(full, "utf8");
      if (secretPatterns.some((pattern) => pattern.test(text))) issues.push(`${relative}: credential pattern`);
    }
  }
}
visit(archive);
console.log(JSON.stringify({ ok: issues.length === 0, files, textFiles, issues }, null, 2));
if (issues.length) process.exitCode = 1;
