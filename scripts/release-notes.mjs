#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Extract the release notes for a version from CHANGELOG.md (Keep a Changelog format).
// Usage: node scripts/release-notes.mjs [version]
// Defaults to the version in package.json.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkgVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const version = (process.argv[2] ?? pkgVersion).replace(/^v/, "");

const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const headingRe = new RegExp(`^## \\[${escaped}\\][^\\r\\n]*\\r?\\n`, "m");
const match = headingRe.exec(changelog);

if (!match) {
  console.error(`release-notes: no "## [${version}]" section found in CHANGELOG.md`);
  process.exit(1);
}

const rest = changelog.slice(match.index + match[0].length);
const nextHeading = /^## \[/m.exec(rest);
const body = (nextHeading ? rest.slice(0, nextHeading.index) : rest).trim();

if (!body) {
  console.error(`release-notes: section "## [${version}]" in CHANGELOG.md is empty`);
  process.exit(1);
}

process.stdout.write(`${body}\n`);
