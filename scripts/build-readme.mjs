#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Build assets/README.pdf from README.md: Markdown -> HTML (marked) -> PDF (headless Chrome/Chromium).
// The PDF is embedded into the binary and opened by `gather-spotify-status --readme`.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { marked } from "marked";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "assets");
const outPdf = path.join(outDir, "README.pdf");

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function findChrome() {
  const localAppData = process.env.LOCALAPPDATA;
  const candidates = [
    process.env.CHROME_PATH,
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    localAppData && path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    localAppData && path.join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe"),
  ].filter(Boolean);
  for (const c of candidates) {
    if (path.isAbsolute(c) || c.includes("/") || c.includes("\\")) {
      if (isFile(c)) return c;
      continue;
    }
    if (process.platform === "win32") {
      const r = spawnSync("where.exe", [c], { encoding: "utf8", windowsHide: true });
      const found = r.status === 0 ? r.stdout.split(/\r?\n/)[0]?.trim() : "";
      if (found && isFile(found)) return found;
      continue;
    }
    const r = spawnSync(c, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return c;
  }
  return null;
}

// GitHub-style heading ids so in-document links like (#where-your-secrets-are-stored) work.
function slugify(html) {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z]+;|&#\d+;/gi, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");
}

const md = fs.readFileSync(path.join(root, "README.md"), "utf8");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
let body = marked.parse(md, { gfm: true });
const seen = new Map();
body = body.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (_, level, inner) => {
  let id = slugify(inner);
  const n = seen.get(id) ?? 0;
  seen.set(id, n + 1);
  if (n) id += `-${n}`;
  return `<h${level} id="${id}">${inner}</h${level}>`;
});

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>gather-spotify-status v${version}</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  body { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; font-size: 10.5pt; line-height: 1.5; color: #1f2328; }
  h1 { font-size: 22pt; border-bottom: 2px solid #1db954; padding-bottom: 4px; }
  h2 { font-size: 15pt; border-bottom: 1px solid #d0d7de; padding-bottom: 3px; margin-top: 22px; break-after: avoid; }
  h3 { font-size: 12pt; margin-top: 16px; break-after: avoid; }
  code { font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace; font-size: 9pt; background: #f6f8fa; padding: 1px 4px; border-radius: 4px; }
  pre { background: #f6f8fa; padding: 8px 10px; border-radius: 6px; overflow-wrap: anywhere; white-space: pre-wrap; break-inside: avoid; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; width: 100%; font-size: 9pt; break-inside: avoid; }
  th, td { border: 1px solid #d0d7de; padding: 4px 6px; text-align: left; vertical-align: top; }
  th { background: #f6f8fa; }
  blockquote { margin: 8px 0; padding: 4px 12px; border-left: 4px solid #1db954; background: #f3fbf6; color: #333; }
  a { color: #0969da; text-decoration: none; }
  .footer { margin-top: 28px; color: #777; font-size: 8.5pt; }
</style></head>
<body>
${body}
<p class="footer">gather-spotify-status v${version}</p>
</body></html>`;

const chrome = findChrome();
if (!chrome) {
  console.error(
    "build-readme: Chrome/Chromium not found (needed to render README.pdf). Install it or set CHROME_PATH=/path/to/chrome.",
  );
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gss-readme-"));
const htmlFile = path.join(tmp, "README.html");
fs.writeFileSync(htmlFile, html);
fs.mkdirSync(outDir, { recursive: true });
fs.rmSync(outPdf, { force: true });

const res = spawnSync(
  chrome,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--no-first-run",
    "--no-pdf-header-footer",
    `--user-data-dir=${path.join(tmp, "profile")}`, // don't collide with a running Chrome
    `--print-to-pdf=${outPdf}`,
    pathToFileURL(htmlFile).href,
  ],
  { encoding: "utf8", timeout: 60000, windowsHide: true },
);
try {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
} catch {
  // Windows may briefly keep a handle open in the temp profile directory.
}

if (res.status !== 0 || !fs.existsSync(outPdf)) {
  console.error(`build-readme: Chrome failed to print the PDF.\n${res.stderr || ""}`);
  process.exit(1);
}
console.log(`build-readme: wrote ${path.relative(root, outPdf)} (${Math.round(fs.statSync(outPdf).size / 1024)} KB)`);
