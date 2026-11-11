#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Build standalone gather-spotify-status binaries (cross-platform: Linux, macOS, Windows).
//   node scripts/build.mjs          all 5 platforms -> bin/gather-spotify-status-<os>-<arch>[.exe] + bin/SHA256SUMS
//   node scripts/build.mjs --host   this machine only -> bin/gather-spotify-status[.exe]
// Runs the type check, lint and tests first; any failure stops the build.

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const NAME = "gather-spotify-status";
const OUT = "bin";
const outDir = path.join(root, OUT);
const ENTRY = "src/index.ts";
const TARGETS = ["bun-linux-x64", "bun-linux-arm64", "bun-darwin-x64", "bun-darwin-arm64", "bun-windows-x64"];

const args = process.argv.slice(2);
let hostOnly = false;
if (args.length === 1 && args[0] === "--host") {
  hostOnly = true;
} else if (args.length > 0) {
  console.error("usage: build.mjs [--host]");
  process.exit(2);
}

function findBun() {
  const exe = process.platform === "win32" ? "bun.exe" : "bun";
  const candidates = [process.env.BUN_PATH, exe, path.join(os.homedir(), ".bun", "bin", exe)].filter(Boolean);
  for (const c of candidates) {
    const r = spawnSync(c, ["--version"], { encoding: "utf8", windowsHide: true });
    if (r.status === 0) return c;
  }
  return null;
}

function run(cmd, cmdArgs) {
  const r = spawnSync(cmd, cmdArgs, { stdio: "inherit", cwd: root });
  if (r.error) {
    console.error(`${cmd}: ${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${bytes}B`;
}

const bun = findBun();
if (!bun) {
  console.error("bun not found: install from https://bun.sh");
  process.exit(1);
}

const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
console.log(`Building ${NAME} v${version}`);

run(process.execPath, [path.join(root, "node_modules", "typescript", "bin", "tsc"), "--noEmit"]);
run(process.execPath, [path.join(root, "node_modules", "@biomejs", "biome", "bin", "biome"), "ci", "."]);
run(bun, ["test"]); // unit tests must pass before building
run(process.execPath, [path.join(root, "scripts", "build-readme.mjs")]); // assets/README.pdf, embedded for --readme

fs.mkdirSync(outDir, { recursive: true });

if (hostOnly) {
  const hostOut = path.join(outDir, process.platform === "win32" ? `${NAME}.exe` : NAME);
  run(bun, ["build", ENTRY, "--compile", "--minify", "--outfile", hostOut]);
  run(hostOut, ["--version"]);
  process.exit(0);
}

for (const f of fs.readdirSync(outDir)) {
  if (f.startsWith(`${NAME}-`) || f === "SHA256SUMS") {
    fs.rmSync(path.join(outDir, f), { force: true });
  }
}

const builtFiles = [];
for (const target of TARGETS) {
  const platform = target.replace(/^bun-/, ""); // e.g. linux-x64
  const ext = platform.startsWith("windows-") ? ".exe" : "";
  const fileName = `${NAME}-${platform}${ext}`;
  const outfile = path.join(outDir, fileName);
  console.log(`==> ${target} -> ${OUT}/${fileName}`);
  run(bun, ["build", ENTRY, "--compile", "--minify", `--target=${target}`, "--outfile", outfile]);
  builtFiles.push(fileName);
}

builtFiles.sort();
const sums = `${builtFiles
  .map((fileName) => {
    const data = fs.readFileSync(path.join(outDir, fileName));
    const hash = crypto.createHash("sha256").update(data).digest("hex");
    return `${hash}  ${fileName}`;
  })
  .join("\n")}\n`;
fs.writeFileSync(path.join(outDir, "SHA256SUMS"), sums);

console.log("\nBuilt:");
for (const fileName of [...builtFiles, "SHA256SUMS"]) {
  const fullPath = path.join(outDir, fileName);
  const { size } = fs.statSync(fullPath);
  console.log(`  ${OUT}/${fileName} (${formatSize(size)})`);
}
