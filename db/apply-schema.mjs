import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = path.join(ROOT, "data");
const DB_PATH = path.join(DATA_DIR, "game-news-unified.sqlite");
const SCHEMA_PATH = path.join(ROOT, "schema.sql");

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH);
const sql = fs.readFileSync(SCHEMA_PATH, "utf8");
db.exec(sql);
console.log("Schema 已应用:", DB_PATH);
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
console.log("表:", tables.join(", "));
db.close();
