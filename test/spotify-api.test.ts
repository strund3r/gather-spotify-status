// refreshTokens, fetchPlayback and the browser login against a local mock of Spotify's servers.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import type { Config } from "../src/config";
import { spotifyLogin } from "../src/oauth";
import { fetchPlayback, refreshTokens } from "../src/spotify";

const cfg: Config = {
  GATHER_API_KEY: "g",
  GATHER_SPACE_ID: "s/x",
  SPOTIFY_CLIENT_ID: "cid",
  SPOTIFY_CLIENT_SECRET: "csec",
};
const expectedAuth = `Basic ${Buffer.from("cid:csec").toString("base64")}`;

let server: ReturnType<typeof Bun.serve>;
let lastTokenForm: URLSearchParams | undefined;
let lastPlaybackUrl: URL | undefined;
const saved = { accounts: process.env.GSS_SPOTIFY_ACCOUNTS, api: process.env.GSS_SPOTIFY_API };

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/token") {
        if (req.headers.get("authorization") !== expectedAuth)
          return Response.json({ error: "invalid_client" }, { status: 400 });
        const form = new URLSearchParams(await req.text());
        lastTokenForm = form;
        if (form.get("grant_type") === "authorization_code") {
          return Response.json({ access_token: "A1", refresh_token: "R1", expires_in: 3600, scope: "s1 s2" });
        }
        switch (form.get("refresh_token")) {
          case "good":
            return Response.json({ access_token: "A2", expires_in: 600, scope: "s1" }); // no rotation
          case "rotate":
            return Response.json({ access_token: "A3", refresh_token: "R3", expires_in: 600 });
          case "revoked":
            return Response.json(
              { error: "invalid_grant", error_description: "Refresh token revoked" },
              { status: 400 },
            );
          default:
            return new Response("unavailable", { status: 503 });
        }
      }
      if (url.pathname.startsWith("/v1/me/player")) {
        lastPlaybackUrl = url;
        switch (req.headers.get("authorization")) {
          case "Bearer none":
            return new Response(null, { status: 204 });
          case "Bearer limited":
            return new Response("slow down", { status: 429, headers: { "Retry-After": "7" } });
          case "Bearer expired":
            return Response.json({ error: { status: 401, message: "expired" } }, { status: 401 });
          default:
            return Response.json({ is_playing: true, currently_playing_type: "track" });
        }
      }
      return new Response("not found", { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  process.env.GSS_SPOTIFY_ACCOUNTS = base;
  process.env.GSS_SPOTIFY_API = base;
});

afterAll(() => {
  server.stop(true);
  for (const [key, value] of [
    ["GSS_SPOTIFY_ACCOUNTS", saved.accounts],
    ["GSS_SPOTIFY_API", saved.api],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("refreshTokens", () => {
  test("success keeps the old refresh token when Spotify doesn't rotate it", async () => {
    const r = await refreshTokens(cfg, "good", 1000);
    expect(r).toEqual({
      ok: true,
      tokens: { accessToken: "A2", refreshToken: "good", expiresAt: 601_000, scope: "s1" },
    });
    expect(lastTokenForm?.get("grant_type")).toBe("refresh_token");
  });
  test("rotated refresh token is returned", async () => {
    const r = await refreshTokens(cfg, "rotate");
    expect(r.ok && r.tokens.refreshToken).toBe("R3");
  });
  test("invalid_grant → revoked", async () => {
    const r = await refreshTokens(cfg, "revoked");
    expect(r).toMatchObject({ ok: false, revoked: true });
    expect(!r.ok && r.message).toContain("invalid_grant: Refresh token revoked");
  });
  test("server error → not revoked (retry later)", async () => {
    expect(await refreshTokens(cfg, "other")).toMatchObject({ ok: false, revoked: false });
  });
  test("wrong client credentials → revoked (invalid_client)", async () => {
    const r = await refreshTokens({ ...cfg, SPOTIFY_CLIENT_SECRET: "wrong" }, "good");
    expect(r).toMatchObject({ ok: false, revoked: true });
  });
});

describe("fetchPlayback", () => {
  test("200 with JSON; asks for episodes; endpoint depends on `player`", async () => {
    const r = await fetchPlayback("ok", true);
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ is_playing: true, currently_playing_type: "track" });
    expect(lastPlaybackUrl?.pathname).toBe("/v1/me/player");
    expect(lastPlaybackUrl?.searchParams.get("additional_types")).toBe("episode");
    await fetchPlayback("ok", false);
    expect(lastPlaybackUrl?.pathname).toBe("/v1/me/player/currently-playing");
  });
  test("204, 401 and 429 are returned, not thrown; Retry-After parsed", async () => {
    expect((await fetchPlayback("none", true)).status).toBe(204);
    expect((await fetchPlayback("expired", true)).status).toBe(401);
    expect(await fetchPlayback("limited", true)).toMatchObject({ status: 429, retryAfter: 7 });
  });
  test("network errors throw", async () => {
    process.env.GSS_SPOTIFY_API = "http://127.0.0.1:1";
    try {
      await expect(fetchPlayback("ok", true)).rejects.toThrow();
    } finally {
      process.env.GSS_SPOTIFY_API = `http://127.0.0.1:${server.port}`;
    }
  });
});

describe("spotifyLogin (state + PKCE)", () => {
  test("full flow: redirect, bad state rejected, code exchanged with the verifier", async () => {
    let loginUrl = "";
    let listening: () => void = () => {};
    const isListening = new Promise<void>((resolve) => {
      listening = resolve;
    });
    const login = spotifyLogin(cfg, {
      port: 0,
      openBrowser: false,
      onListening: (u) => {
        loginUrl = u;
        listening();
      },
    });
    await isListening;

    const start = await fetch(`${loginUrl}/`, { redirect: "manual" });
    expect(start.status).toBe(302);
    const authorize = new URL(start.headers.get("location") ?? "");
    expect(authorize.pathname).toBe("/authorize");
    const q = authorize.searchParams;
    expect(q.get("client_id")).toBe("cid");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("redirect_uri")).toBe(`${loginUrl}/callback`);
    expect(q.get("scope")).toContain("user-read-playback-state");
    const state = q.get("state") ?? "";
    const challenge = q.get("code_challenge") ?? "";

    expect((await fetch(`${loginUrl}/callback?state=forged&code=abc`)).status).toBe(400);
    expect((await fetch(`${loginUrl}/callback?error=access_denied`)).status).toBe(400);

    const done = await fetch(`${loginUrl}/callback?state=${encodeURIComponent(state)}&code=abc`);
    expect(done.status).toBe(200);
    expect(await done.text()).toContain("Logged in to Spotify");

    const verifier = lastTokenForm?.get("code_verifier") ?? "";
    const expected = crypto.createHash("sha256").update(verifier).digest("base64url");
    expect(challenge).toBe(expected);
    expect(lastTokenForm?.get("code")).toBe("abc");

    expect(await login).toMatchObject({ accessToken: "A1", refreshToken: "R1", scope: "s1 s2" });
  });

  test("port in use → rejects with a readable error", async () => {
    await expect(spotifyLogin(cfg, { port: Number(server.port), openBrowser: false })).rejects.toThrow(
      /already in use/,
    );
  });
});
