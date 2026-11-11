// SPDX-License-Identifier: GPL-3.0-or-later
// Local control channel for the running instance: --stop, --pause, --resume, --set (reload), --status.
// HTTP on 127.0.0.1, random port, random bearer token. Port + token live in the PID file (mode 0600),
// so only the same user can control it. Works the same on Windows, where there are no signals.
import crypto from "node:crypto";
import http from "node:http";
import { LOOPBACK } from "./constants";
import type { GatherStatus } from "./status";
import { errorMessage, isRecord } from "./util";

const ACTIONS = ["stop", "pause", "resume", "reload", "status"] as const;
type ControlAction = (typeof ACTIONS)[number];

const DEFAULT_TIMEOUT_MS = 3000;

function isControlAction(s: string): s is ControlAction {
  return (ACTIONS as readonly string[]).includes(s);
}

/** GET /status response. */
export interface StatusPayload {
  version: string;
  connected: boolean;
  paused: boolean;
  sessionExpired: boolean;
  outsideWorkHours: boolean;
  lastStatus: GatherStatus | null;
  lastError: string | null;
  backoffUntil: number;
}

export function isStatusPayload(v: unknown): v is StatusPayload {
  return (
    isRecord(v) &&
    typeof v.connected === "boolean" &&
    typeof v.paused === "boolean" &&
    typeof v.backoffUntil === "number" &&
    (v.lastStatus === null || (isRecord(v.lastStatus) && typeof v.lastStatus.text === "string"))
  );
}

export interface ControlHandlers {
  stop(): Promise<void> | void;
  pause(): void;
  resume(): void;
  reload(): void;
  status(): StatusPayload;
}

export interface ControlServer {
  port: number;
  token: string;
  close(): void;
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const m = /^Bearer (.+)$/.exec(header ?? "");
  if (!m?.[1]) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function startControlServer(handlers: ControlHandlers): Promise<ControlServer> {
  const token = crypto.randomBytes(32).toString("hex");
  const server = http.createServer(async (req, res) => {
    const reply = (code: number, body: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (!tokenMatches(req.headers.authorization, token)) return reply(401, { error: "unauthorized" });

    const action = (req.url ?? "").replace(/^\//, "");
    if (!isControlAction(action)) return reply(404, { error: "unknown action" });
    try {
      if (action === "status") {
        return req.method === "GET" ? reply(200, handlers.status()) : reply(405, { error: "method not allowed" });
      }
      if (req.method !== "POST") return reply(405, { error: "method not allowed" });
      if (action === "stop") {
        reply(200, { ok: true });
        await handlers.stop();
        return;
      }
      handlers[action]();
      return reply(200, { ok: true });
    } catch (e) {
      return reply(500, { error: errorMessage(e) });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.unref(); // don't keep the process alive by itself
      resolve({ port, token, close: () => server.close() });
    });
  });
}

/** Call the running instance. Resolves with the parsed JSON body, or null if unreachable/unauthorized. */
export function controlRequest(
  target: { port?: number; token?: string },
  action: ControlAction,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  if (!target.port || !target.token) return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: LOOPBACK,
        port: target.port,
        path: `/${action}`,
        method: action === "status" ? "GET" : "POST",
        headers: { Authorization: `Bearer ${target.token}` },
        timeout: timeoutMs,
        agent: false,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (d: string) => {
          body += d;
        });
        res.on("end", () => {
          if (res.statusCode !== 200) return resolve(null);
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
    req.end();
  });
}
