// SPDX-License-Identifier: GPL-3.0-or-later
// TLS check before connecting: corporate TLS inspection (Netskope) breaks certificate verification.
import fs from "node:fs";
import https from "node:https";
import { err } from "./colors";
import { APP_NAME } from "./constants";
import { UserError } from "./errors";
import { reExec } from "./proc";
import { ask } from "./prompt";
import { errorCode, errorMessage } from "./util";

const PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_PROBE_URLS = "https://accounts.spotify.com/,https://api.spotify.com/,https://api.gather.town/";

/** Undocumented GSS_TLS_PROBE_URLS override: lets tests point the probe at a local server. */
function probeUrls(): string[] {
  return (process.env.GSS_TLS_PROBE_URLS || DEFAULT_PROBE_URLS)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const NETSKOPE_CA_PATHS: Record<string, string[]> = {
  darwin: [
    "/Library/Application Support/Netskope/STAgent/data/nscacert.pem",
    "/Library/Application Support/Netskope/STAgent/data/netskope-cert-bundle.pem",
  ],
  win32: [
    "C:\\ProgramData\\netskope\\stagent\\data\\nscacert.pem",
    "C:\\ProgramData\\netskope\\stagent\\data\\netskope-cert-bundle.pem",
  ],
  linux: [
    "/opt/netskope/stagent/data/nscacert.pem",
    "/opt/netskope/stagent/data/netskope-cert-bundle.pem",
    "/opt/netskope/stagent/download/nscacert.pem",
  ],
};

const TLS_ERROR_CODES = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "CERT_UNTRUSTED",
  "CERT_SIGNATURE_FAILURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

export type ProbeResult = { ok: true } | { ok: false; tls: boolean; url: string; code: string; message: string };

export function isTlsError(e: unknown): boolean {
  const code = errorCode(e) ?? "";
  if (TLS_ERROR_CODES.has(code)) return true;
  return /CERT|SELF_SIGNED|certificate/i.test(`${code} ${errorMessage(e)}`);
}

function probeOne(url: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const req = https.request(url, { method: "HEAD", agent: false, timeout: PROBE_TIMEOUT_MS }, (res) => {
      res.resume();
      req.destroy();
      resolve({ ok: true });
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })));
    req.on("error", (e) =>
      resolve({ ok: false, tls: isTlsError(e), url, code: errorCode(e) ?? "UNKNOWN", message: e.message }),
    );
    req.end();
  });
}

/** Probe all URLs; the first TLS failure, else the first other failure, else ok. */
export async function probeAll(urls = probeUrls()): Promise<ProbeResult> {
  const results = await Promise.all(urls.map(probeOne));
  // Prefer reporting a TLS failure over a network failure.
  return results.find((r) => !r.ok && r.tls) ?? results.find((r) => !r.ok) ?? { ok: true };
}

function findNetskopeCa(): string | undefined {
  const candidates = NETSKOPE_CA_PATHS[process.platform] ?? [];
  return candidates.find((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

function extraCaHelp(): string {
  return (
    "To keep TLS verification on, point NODE_EXTRA_CA_CERTS at your corporate root CA (PEM), e.g.\n" +
    `  NODE_EXTRA_CA_CERTS=/path/to/nscacert.pem ${APP_NAME}`
  );
}

function warnDisabled(): void {
  console.warn(
    err.red(
      err.bold("WARNING: TLS verification DISABLED for this run.") +
        " Traffic (Gather API key, Spotify secret/tokens) can be read by anyone intercepting the connection.",
    ),
  );
}

/**
 * Verify TLS to Spotify and Gather before connecting. On certificate errors, try the
 * Netskope CA; if that doesn't help, ask (every run) whether to disable verification.
 * Throws UserError when verification fails and the user doesn't allow disabling it.
 */
export async function ensureTls(opts: { insecure: boolean }): Promise<void> {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    warnDisabled();
    return;
  }

  const result = await probeAll();
  if (result.ok) return;

  if (!result.tls) {
    console.warn(
      err.yellow(
        `Network check failed for ${result.url} (${result.code}: ${result.message}). Continuing; requests will be retried.`,
      ),
    );
    return;
  }

  // 1. Secure fix: trust the Netskope root CA, if installed and not already in use.
  const ca = findNetskopeCa();
  if (ca && process.env.NODE_EXTRA_CA_CERTS !== ca && !process.env.GSS_TRIED_NETSKOPE_CA) {
    console.warn(`TLS certificate check failed (${result.code}). Using Netskope CA from ${ca}`);
    return reExec({ NODE_EXTRA_CA_CERTS: ca, GSS_TRIED_NETSKOPE_CA: "1" });
  }

  // 2. Last resort: disable verification, only with explicit consent.
  const explanation = err.yellow(
    `TLS certificate check failed for ${result.url} (${result.code}).\n` +
      "This is probably Netskope (corporate TLS inspection) intercepting the connection.\n" +
      "Without TLS verification it should work, but traffic (Gather API key, Spotify secret/tokens)\n" +
      "could be read by anyone intercepting it.",
  );

  if (opts.insecure || process.env.GSS_INSECURE_TLS === "1") {
    console.warn(explanation);
    return reExec({ NODE_TLS_REJECT_UNAUTHORIZED: "0" });
  }

  console.warn(explanation);
  if (!process.stdin.isTTY) {
    throw new UserError(`\n${extraCaHelp()}\nOr run with --insecure (or GSS_INSECURE_TLS=1) to disable verification.`);
  }

  const answer = (await ask("Disable TLS verification for this run? [y/N] ")).trim().toLowerCase();
  if (answer === "y" || answer === "yes") {
    return reExec({ NODE_TLS_REJECT_UNAUTHORIZED: "0" });
  }
  throw new UserError(`\n${extraCaHelp()}`);
}
