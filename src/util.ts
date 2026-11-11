// SPDX-License-Identifier: GPL-3.0-or-later
// Small generic helpers.
import axios from "axios";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The message of any thrown value. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The `code` property of a thrown Node/axios error ("ENOENT", "ECONNRESET", ...), if any. */
export function errorCode(e: unknown): string | undefined {
  return isRecord(e) && typeof e.code === "string" ? e.code : undefined;
}

/** Describe an error without dumping request config (which contains Authorization headers). */
export function describeError(e: unknown): string {
  if (axios.isAxiosError(e)) {
    const status = e.response?.status;
    const data: unknown = e.response?.data;
    let apiError: string | undefined;
    if (isRecord(data)) {
      if (typeof data.error === "string") {
        apiError = data.error + (typeof data.error_description === "string" ? `: ${data.error_description}` : "");
      } else if (isRecord(data.error) && typeof data.error.message === "string") {
        apiError = data.error.message;
      }
    }
    return [e.code, status && `HTTP ${status}`, apiError || e.message].filter(Boolean).join(" - ");
  }
  return errorMessage(e);
}

/** Compare "x.y.z" versions: <0 if a<b, 0 if equal, >0 if a>b. */
export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
