import { describe, expect, test } from "bun:test";
import http from "node:http";
import { controlRequest, startControlServer } from "../src/control";

function setup() {
  const calls: string[] = [];
  return startControlServer({
    stop: () => {
      calls.push("stop");
    },
    pause: () => calls.push("pause"),
    resume: () => calls.push("resume"),
    reload: () => calls.push("reload"),
    status: () => ({
      version: "test",
      connected: true,
      paused: calls.includes("pause"),
      sessionExpired: false,
      outsideWorkHours: false,
      lastStatus: null,
      lastError: null,
      backoffUntil: 0,
    }),
  }).then((server) => ({ server, calls }));
}

function raw(port: number, path: string, method: string, auth?: string): Promise<number> {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method, headers: auth ? { Authorization: auth } : {} },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", () => resolve(-1));
    req.end();
  });
}

describe("control channel", () => {
  test("listens on loopback with a 64-hex-char token", async () => {
    const { server } = await setup();
    expect(server.port).toBeGreaterThan(0);
    expect(server.token).toMatch(/^[0-9a-f]{64}$/);
    server.close();
  });

  test("rejects missing / wrong tokens", async () => {
    const { server, calls } = await setup();
    expect(await raw(server.port, "/pause", "POST")).toBe(401);
    expect(await raw(server.port, "/pause", "POST", "Bearer nope")).toBe(401);
    expect(await raw(server.port, "/pause", "POST", `Bearer ${server.token}x`)).toBe(401);
    expect(await controlRequest({ port: server.port, token: "0".repeat(64) }, "pause")).toBeNull();
    expect(calls).toEqual([]);
    server.close();
  });

  test("round trip: pause, status, resume, reload, stop", async () => {
    const { server, calls } = await setup();
    const t = { port: server.port, token: server.token };
    expect(await controlRequest(t, "pause")).toEqual({ ok: true });
    expect(await controlRequest(t, "status")).toMatchObject({ paused: true, connected: true });
    expect(await controlRequest(t, "resume")).toEqual({ ok: true });
    expect(await controlRequest(t, "reload")).toEqual({ ok: true });
    expect(await controlRequest(t, "stop")).toEqual({ ok: true });
    expect(calls).toEqual(["pause", "resume", "reload", "stop"]);
    server.close();
  });

  test("wrong method / unknown action", async () => {
    const { server } = await setup();
    const auth = `Bearer ${server.token}`;
    expect(await raw(server.port, "/pause", "GET", auth)).toBe(405);
    expect(await raw(server.port, "/nope", "POST", auth)).toBe(404);
    server.close();
  });

  test("client returns null when nothing listens or no port/token", async () => {
    expect(await controlRequest({}, "status")).toBeNull();
    expect(await controlRequest({ port: 1, token: "x" }, "status", 500)).toBeNull();
  });
});
