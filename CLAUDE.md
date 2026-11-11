# gather-spotify-status

A CLI that sets your Gather status to what you're playing on Spotify. It's TypeScript, run and compiled by Bun (`bun build --compile`) into standalone binaries for 5 platforms. See README.md for user-facing behavior.

## Commands

```sh
npm ci                 # install (npm owns the lockfile; Bun runs the code)
npm run dev -- <flags> # run from source: bun src/index.ts <flags>
npm run check          # tsc --noEmit + biome check + bun test: run before calling work done
npm run lint:fix       # biome format + safe fixes
npm run build          # checks + host binary -> bin/gather-spotify-status[.exe]
npm run build:all      # checks + 5 platform binaries + bin/SHA256SUMS
```

## Layout

- `src/index.ts`: the entry point. It dispatches commands and is the **only** place that converts errors into exit codes.
- `src/cli.ts`: pure flag parsing (`parseFlags`, `HELP`).
- Shared building blocks, imported by every other module:
  - `src/constants.ts`: `APP_NAME`, `LOOPBACK`. Imports nothing.
  - `src/errors.ts`, `util.ts`, `fsutil.ts`, `paths.ts`, `colors.ts`, `logger.ts`.
- Configuration and secrets:
  - `src/config.ts`: `config.json`, settings, refresh token.
  - `src/secrets.ts`: OS keychain via `Bun.secrets`.
  - `src/settings.ts`: the settings schema.
- Spotify and status logic:
  - `src/spotify.ts`: token refresh, `TokenManager`, playback fetch.
  - `src/oauth.ts`: browser login.
  - `src/status.ts`, `src/workhours.ts`: pure formatting and rules.
  - `src/poller.ts`: the poll loop and error policy. All I/O is injected.
- Background process:
  - `src/service.ts`: the running service. It's the only module that imports the Gather SDK, and `index.ts` loads it lazily.
  - `src/daemon.ts`: launcher↔daemon IPC, plus `--stop` / `--status` / `--pause`.
  - `src/control.ts`: HTTP control channel on 127.0.0.1 with a bearer token.
  - `src/pidfile.ts`, `src/logfile.ts`, `src/proc.ts` (re-exec).
- Install and integration:
  - `src/install.ts`: self-install to the per-user bin folder and PATH setup.
  - `src/autostart.ts`, `src/update.ts`, `src/tls.ts`, `src/readme.ts`.

## Conventions

- **Errors:**
  - Expected failures meant for the user throw `UserError(message, exitCode)`, or `UsageError` for bad flags (exit 2, prints help).
  - Don't call `process.exit` outside `index.ts`. The only exceptions are `proc.ts` `reExec` and the `service.ts` shutdown.
  - Catch as `unknown` and use `errorMessage(e)` / `errorCode(e)` from `util.ts`.
- **Output:**
  - Normal output: `console.log` with `out.*` colors.
  - Warnings and errors: `console.warn`/`console.error` with `err.*` colors.
  - Background-process logging: `logger.*`.
- **Files:** private files (config, PID file, caches) go through `fsutil.writePrivateFile`/`writePrivateJson`, which write atomically with mode 0600.
- **Types:**
  - No `any` and no non-null `!`; Biome enforces this.
  - Treat external JSON as `unknown` and narrow it with `isRecord` / type guards.
  - `noUncheckedIndexedAccess` is on.
- **Env vars:** read them inside functions, not at import time. The undocumented `GSS_*` test hooks are `GSS_SPOTIFY_API`, `GSS_SPOTIFY_ACCOUNTS`, `GSS_GITHUB_API`, `GSS_TLS_PROBE_URLS` and `GSS_KEYCHAIN_SERVICE`.
- **Version:** only `package.json` holds it (`src/version.ts` imports it). For each release, add a `CHANGELOG.md` entry.

## Test safety (important)

Tests must never touch the real user environment:

- **Home folder:** never use the real HOME. Bun's `os.homedir()` ignores runtime `HOME` changes, so pass paths explicitly (e.g. `ensureOnPath(dir, home)`, `openLog(file, dir)`, `readPidFile(file)`), or set `XDG_CONFIG_HOME` to a `mkdtemp` dir. Guard temp homes with a `startsWith(os.tmpdir())` check.
- **Keychain:** never use the real keychain. Mock it with `mock.module("../src/secrets", ...)`.
- **Opener:** never call `xdg-open`, `open` or `start`. Keep `openExternal` out of tests, and use `spotifyLogin({ openBrowser: false })`.
- **Network:** never reach real Spotify, Gather or GitHub. Use `Bun.serve({ port: 0 })` mocks together with the `GSS_*` hooks.
