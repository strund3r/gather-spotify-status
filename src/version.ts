// SPDX-License-Identifier: GPL-3.0-or-later
// Single source of truth: package.json "version" (Bun inlines it at build time).
import { version } from "../package.json" with { type: "json" };

export const VERSION: string = version;
