#!/usr/bin/env node
/**
 * refresh-dashboard.js
 *
 * Reads the latest trace(s) from ~/.worldcup-settlement/traces.jsonl and
 * writes them to dashboard/data/traces.json so the 4-panel Next.js dashboard
 * reflects the most recent agent run.
 *
 * Usage (from repo root):
 *   node scripts/refresh-dashboard.js
 *
 * Run after any agent loop to update the dashboard snapshot before deploying.
 * ponytail: reads all lines, writes them all; no filtering or dedup — the
 * dashboard lib (traces.ts) already does dedup+sort. Upgrade path: stream
 * large files if traces exceed hundreds of thousands of lines.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const SRC = path.join(os.homedir(), ".worldcup-settlement", "traces.jsonl");
const DEST = path.join(__dirname, "..", "dashboard", "data", "traces.json");

if (!fs.existsSync(SRC)) {
  console.error(`Source not found: ${SRC}`);
  process.exit(1);
}

const lines = fs
  .readFileSync(SRC, "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "");

const records = lines
  .map((l, i) => {
    try {
      return JSON.parse(l);
    } catch (e) {
      console.error(`Skipping malformed line ${i + 1}: ${e.message}`);
      return null;
    }
  })
  .filter(Boolean);

fs.writeFileSync(DEST, JSON.stringify(records, null, 2) + "\n", "utf8");
console.log(`Wrote ${records.length} trace(s) to ${DEST}`);
console.log(
  `Latest: ${records[records.length - 1]?.timestamp} fixtureId=${
    records[records.length - 1]?.fixtureId
  } impl=${records[records.length - 1]?.impl}`
);
