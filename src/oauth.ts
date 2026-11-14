// SPDX-License-Identifier: GPL-3.0-or-later
// Spotify browser login: Authorization Code flow with state + PKCE, served on 127.0.0.1.
import crypto from "node:crypto";
import http from "node:http";
import querystring from "node:querystring";
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

const MAX_PENDING_STATES = 32;

function sendText(res: http.ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function sendHtml(res: http.ServerResponse, status: number, html: string, closeConnection = false): void {
  const headers: http.OutgoingHttpHeaders = { "Content-Type": "text/html; charset=utf-8" };
  if (closeConnection) headers.Connection = "close";
  res.writeHead(status, headers);
  res.end(html);
}

function redirect(res: http.ServerResponse, location: string): void {
  res.writeHead(302, { Location: location });
  res.end();
}

/**
 * Run the local OAuth login (state + PKCE). Resolves with tokens once the user approves, then closes
 * the server. Rejects with a UserError if the local server can't start (e.g. port in use).
 */
export function spotifyLogin(cfg: Config, opts: LoginOptions = {}): Promise<TokenSet> {
  const port = opts.port ?? LOGIN_PORT;
  return new Promise((resolve, reject) => {
    let done = false;
    let loginUrl = `http://${LOOPBACK}:${port}`;
    const redirectUri = () => `${loginUrl}/callback`;
    // OAuth state -> PKCE code_verifier, for logins in progress. Each state is single-use.
    const pending = new Map<string, string>();

    const server = http.createServer(async (req, res) => {
      if (req.method !== "GET") {
        sendText(res, 405, "Method Not Allowed");
        return;
      }

      let reqUrl: URL;
      try {
        reqUrl = new URL(req.url ?? "/", loginUrl);
      } catch {
        sendText(res, 400, "Bad Request");
        return;
      }

      if (reqUrl.pathname === "/") {
        if (done) {
          sendHtml(res, 200, loginDonePage("Already logged in to Spotify"));
          return;
        }
        if (pending.size >= MAX_PENDING_STATES) pending.clear();
        const state = base64url(crypto.randomBytes(16));
        const verifier = base64url(crypto.randomBytes(32));
        const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
        pending.set(state, verifier);

        redirect(
          res,
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
        return;
      }

      if (reqUrl.pathname === "/callback") {
        if (done) {
          sendText(res, 410, "Already logged in. Restart the app to log in again.");
          return;
        }

        const error = reqUrl.searchParams.get("error");
        if (error !== null) {
          const safeError = /^[a-zA-Z0-9_.-]{1,64}$/.test(error) ? error : "access_denied";
          sendText(res, 400, `Spotify login failed: ${safeError}`);
          return;
        }

        const state = reqUrl.searchParams.get("state");
        const verifier = state ? pending.get(state) : undefined;
        if (!state || verifier === undefined) {
          sendText(res, 400, `Invalid or expired login state. Start again from ${loginUrl}`);
          return;
        }
        pending.delete(state);

        const code = reqUrl.searchParams.get("code");
        if (!code) {
          sendText(res, 400, "Missing or invalid authorization code.");
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
          sendHtml(res, 200, loginDonePage("Logged in to Spotify"), true);
          server.close();
          console.log(out.green("✓ Logged in to Spotify."));
          resolve(tokens);
        } catch (e) {
          console.error(err.red(`Error exchanging code for tokens: ${describeError(e)}`));
          sendText(res, 500, "Internal Server Error");
        }
        return;
      }

      sendText(res, 404, "Not Found");
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
    server.listen(port, LOOPBACK, () => {
      const addr = server.address();
      if (addr && typeof addr === "object") loginUrl = `http://${LOOPBACK}:${addr.port}`;
      console.log(`Open ${out.underline(out.cyan(loginUrl))} to log in to Spotify`);
      opts.onListening?.(loginUrl);
      if (opts.openBrowser !== false) void openExternal(loginUrl); // best-effort; the URL is printed anyway
    });
  });
}
