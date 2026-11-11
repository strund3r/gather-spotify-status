// TLS probe against a local HTTPS server with a self-signed certificate (needs openssl).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isTlsError, probeAll } from "../src/tls";

const hasOpenssl = spawnSync("openssl", ["version"]).status === 0;
let dir: string;
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(() => {
  if (!hasOpenssl) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gss-tls-"));
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  const r = spawnSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=127.0.0.1",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
    "-keyout",
    key,
    "-out",
    cert,
  ]);
  if (r.status !== 0) throw new Error(`openssl failed: ${r.stderr}`);
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    tls: { key: Bun.file(key), cert: Bun.file(cert) },
    fetch: () => new Response("ok"),
  });
});
afterAll(() => {
  server?.stop(true);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test("isTlsError", () => {
  expect(isTlsError(Object.assign(new Error("x"), { code: "SELF_SIGNED_CERT_IN_CHAIN" }))).toBe(true);
  expect(isTlsError(new Error("unable to verify the first certificate"))).toBe(true);
  expect(isTlsError(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }))).toBe(false);
});

describe.skipIf(!hasOpenssl)("probeAll", () => {
  test("self-signed certificate → TLS failure", async () => {
    const r = await probeAll([`https://127.0.0.1:${server?.port}/`]);
    expect(r).toMatchObject({ ok: false, tls: true });
  });

  test("TLS failure is preferred over a network failure", async () => {
    const r = await probeAll(["https://127.0.0.1:1/", `https://127.0.0.1:${server?.port}/`]);
    expect(r).toMatchObject({ ok: false, tls: true });
  });

  test("connection refused → network (non-TLS) failure", async () => {
    const r = await probeAll(["https://127.0.0.1:1/"]);
    expect(r).toMatchObject({ ok: false, tls: false });
  });

  test("no URLs → ok", async () => {
    expect(await probeAll([])).toEqual({ ok: true });
  });
});
