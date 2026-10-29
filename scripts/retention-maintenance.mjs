import { openDb } from "../server/tasks/pipeline.mjs";
import { runRetention } from "../server/tasks/retention.mjs";

const stage = process.argv.includes("--stage");
const db = openDb();
try { console.log(JSON.stringify(runRetention(db, { stage, keepDays: 7 }), null, 2)); }
finally { db.close(); }
