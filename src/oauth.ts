// SPDX-License-Identifier: GPL-3.0-or-later
// Spotify browser login: Authorization Code flow with state + PKCE, served on 127.0.0.1.
import crypto from "node:crypto";
import querystring from "node:querystring";
import express, { type Request, type Response } from "express";
import { err, out } from "./colors";
import type { Config } from "./config";
import { APP_NAME, LOOPBACK } from "./constants";
import { UserError } from "./errors";
import { openExternal } from "./open";
import { accountsBase, postToken, SCOPES, type TokenSet, toTokenSet } from "./spotify";
import { describeError, errorCode, errorMessage } from "./util";

/** Fixed: it's part of the redirect URI registered in the Spotify app. */
export const LOGIN_PORT = 42843;

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * "Done" page for the login tab. Tries to close itself; browsers only allow that in some cases
 * (e.g. Chrome when the tab has a single history entry), so it falls back to a "close this tab" message.
 * Content is static: no user/query data is interpolated.
 */
function loginDonePage(message: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${APP_NAME}</title>
<style>
  body { font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center;
         height: 100vh; margin: 0; background: #121212; color: #fff; }
  .box { text-align: center; }
  .check { font-size: 48px; color: #1db954; }
  #hint { color: #b3b3b3; visibility: hidden; }
</style>
</head>
<body>
<div class="box">
  <div class="check">&#10003;</div>
  <h2>${message}</h2>
  <p id="hint">You can close this tab now.</p>
</div>
<script>
  setTimeout(function () {
    window.close();
    // Still here? The browser blocked closing; show the manual hint.
    setTimeout(function () { document.getElementById("hint").style.visibility = "visible"; }, 300);
  }, 1500);
</script>
</body>
</html>`;
}

export interface LoginOptions {
  /** Port to listen on (tests use 0 = random). */
  port?: number;
  /** Open the browser automatically (tests turn it off). */
  openBrowser?: boolean;
  /** Called with the login URL once the server listens. */
  onListening?: (url: string) => void;
}

/**
 * Run the local OAuth login (state + PKCE). Resolves with tokens once the user approves, then closes
 * the server. Rejects with a UserError if the local server can't start (e.g. port in use).
 */
export function spotifyLogin(cfg: Config, opts: LoginOptions = {}): Promise<TokenSet> {
  const port = opts.port ?? LOGIN_PORT;
  return new Promise((resolve, reject) => {
    const app = express();
    let done = false;
    let loginUrl = `http://${LOOPBACK}:${port}`;
    const redirectUri = () => `${loginUrl}/callback`;
    // OAuth state -> PKCE code_verifier, for logins in progress. Each state is single-use.
    const pending = new Map<string, string>();

    app.get("/", (_: Request, res: Response) => {
      if (done) {
        res.send(loginDonePage("Already logged in to Spotify"));
        return;
      }
      const state = base64url(crypto.randomBytes(16));
      const verifier = base64url(crypto.randomBytes(32));
      const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
      pending.set(state, verifier);

      res.redirect(
        `${accountsBase()}/authorize?${querystring.stringify({
          client_id: cfg.SPOTIFY_CLIENT_ID,
          response_type: "code",
          redirect_uri: redirectUri(),
          scope: SCOPES,
          state,
          code_challenge_method: "S256",
          code_challenge: challenge,
        })}`,
      );
    });

    app.get("/callback", async (req: Request, res: Response) => {
      if (done) {
        res.status(410).send("Already logged in. Restart the app to log in again.");
        return;
      }

      const { code, state, error } = req.query;
      if (typeof error === "string") {
        res.status(400).send(`Spotify login failed: ${error}`);
        return;
      }
      const verifier = typeof state === "string" ? pending.get(state) : undefined;
      if (typeof state !== "string" || verifier === undefined) {
        res.status(400).send(`Invalid or expired login state. Start again from ${loginUrl}`);
        return;
      }
      pending.delete(state);

      if (!code || typeof code !== "string") {
        res.status(400).send("Missing or invalid authorization code.");
        return;
      }

      try {
        const tokenResponse = await postToken(cfg, {
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri(),
          code_verifier: verifier,
        });
        const tokens = toTokenSet(tokenResponse.data);

        done = true;
        pending.clear();
        res.set("Connection", "close");
        res.send(loginDonePage("Logged in to Spotify"));
        server.close();
        console.log(out.green("✓ Logged in to Spotify."));
        resolve(tokens);
      } catch (e) {
        console.error(err.red(`Error exchanging code for tokens: ${describeError(e)}`));
        res.status(500).send("Internal Server Error");
      }
    });

    const server = app.listen(port, LOOPBACK, () => {
      const addr = server.address();
      if (addr && typeof addr === "object") loginUrl = `http://${LOOPBACK}:${addr.port}`;
      console.log(`Open ${out.underline(out.cyan(loginUrl))} to log in to Spotify`);
      opts.onListening?.(loginUrl);
      if (opts.openBrowser !== false) void openExternal(loginUrl); // best-effort; the URL is printed anyway
    });
    server.on("error", (e) => {
      reject(
        new UserError(
          errorCode(e) === "EADDRINUSE"
            ? `Port ${port} is already in use. Is another ${APP_NAME} instance running?`
            : `Could not start local login server: ${errorMessage(e)}`,
        ),
      );
    });
  });
}
