// SPDX-License-Identifier: GPL-3.0-or-later
// Parses coverage/lcov.info, writes a Markdown table to $GITHUB_STEP_SUMMARY (when set),
// and fails if total line coverage drops below the minimum threshold.
import fs from "node:fs";
import path from "node:path";

const LCOV_PATH = path.resolve("coverage", "lcov.info");
// Windows skips daemon.test.ts and tls.test.ts until ci/multi-os-matrix, so its lcov baseline is ~71%.
const DEFAULT_MIN_LINES = process.platform === "win32" ? 70 : 75;
const minLines = Number(process.env.MIN_LINE_COVERAGE ?? DEFAULT_MIN_LINES);

if (!fs.existsSync(LCOV_PATH)) {
  console.error(`Coverage file not found: ${LCOV_PATH}. Run 'bun test --coverage' first.`);
  process.exit(1);
}

const raw = fs.readFileSync(LCOV_PATH, "utf8");
const records = [];
let current = null;

for (const line of raw.split(/\r?\n/)) {
  if (line.startsWith("SF:")) {
    const file = line.slice(3).replace(/\\/g, "/");
    current = { file, lf: 0, lh: 0, fnf: 0, fnh: 0 };
  } else if (current && line.startsWith("LF:")) {
    current.lf = Number(line.slice(3)) || 0;
  } else if (current && line.startsWith("LH:")) {
    current.lh = Number(line.slice(3)) || 0;
  } else if (current && line.startsWith("FNF:")) {
    current.fnf = Number(line.slice(4)) || 0;
  } else if (current && line.startsWith("FNH:")) {
    current.fnh = Number(line.slice(4)) || 0;
  } else if (line === "end_of_record" && current) {
    records.push(current);
    current = null;
  }
}

records.sort((a, b) => a.file.localeCompare(b.file));

const totalLf = records.reduce((s, r) => s + r.lf, 0);
const totalLh = records.reduce((s, r) => s + r.lh, 0);
const totalFnf = records.reduce((s, r) => s + r.fnf, 0);
const totalFnh = records.reduce((s, r) => s + r.fnh, 0);

const pct = (hit, found) => (found === 0 ? 100 : (hit / found) * 100);
const totalLinePct = pct(totalLh, totalLf);
const totalFnPct = pct(totalFnh, totalFnf);

if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = records.map(
    (r) =>
      `| \`${r.file}\` | ${pct(r.fnh, r.fnf).toFixed(2)}% (${r.fnh}/${r.fnf}) | ${pct(r.lh, r.lf).toFixed(2)}% (${r.lh}/${r.lf}) |`,
  );
  const summary = [
    "### Test Coverage",
    "",
    "| File | % Funcs | % Lines |",
    "| :--- | ---: | ---: |",
    `| **All files** | **${totalFnPct.toFixed(2)}% (${totalFnh}/${totalFnf})** | **${totalLinePct.toFixed(2)}% (${totalLh}/${totalLf})** |`,
    ...rows,
    "",
    `Minimum required line coverage: **${minLines}%**`,
    "",
  ].join("\n");
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
}

console.log(
  `Coverage total: ${totalLinePct.toFixed(2)}% lines (${totalLh}/${totalLf}), ${totalFnPct.toFixed(2)}% funcs (${totalFnh}/${totalFnf}) [min: ${minLines}%]`,
);

if (totalLinePct < minLines) {
  console.error(`Coverage check failed: ${totalLinePct.toFixed(2)}% is below the ${minLines}% minimum.`);
  process.exit(1);
}
