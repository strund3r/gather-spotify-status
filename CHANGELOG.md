# Changelog

All notable changes to this project. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-11-11

First release. Licensed under GPL-3.0-or-later.

### Added

- **Single executable** for Linux, macOS and Windows (x64 and arm64), built with `bun build --compile`. Nothing else needs to be installed.
- **First-time setup** prompts for the Gather API key, space ID and Spotify client ID/secret. Environment variables are used instead when set, and are never stored.
- **Installs itself** to the per-user bin folder (`~/.local/bin` or `%LOCALAPPDATA%\Programs`), adds it to PATH, and replaces older installed versions. `--no-install` runs a copy where it is.
- **Runs in the background** after login, with `--status`, `--stop`, `--logs [-n N]` and `--foreground`. Gather SDK messages go to the log file only.
- **Stays logged in to Spotify**: the refresh token is saved, so later starts don't open the browser. `--logout` forgets it.
- **Start at login** (`--autostart on|off|status`). The first start in a terminal asks once whether to turn it on.
- **Settings** via `--set key=value` / `--get`, applied to a running copy immediately:
  - status format, emojis, max length;
  - artist blocklist, work hours, private-session detection, debug logging.
- **`--pause` / `--resume`**.
- **`--readme`** opens the bundled README as a PDF. **`--check-update`** checks GitHub releases.
- **Reliable background operation:**
  - refreshes on 401, honors `Retry-After` on 429, backs off on network errors;
  - handles laptop sleep;
  - sends the status only when it changes, and again after a Gather reconnect.

### Security

- Secrets (Gather API key, Spotify client secret, refresh token) are stored in the OS keychain: macOS Keychain, Windows Credential Manager or Secret Service. When no keychain is available, the config file is the fallback, with mode 0600.
- Spotify login with `state` + PKCE on `127.0.0.1`; the callback tab closes itself.
- TLS verification with automatic Netskope CA detection. The app asks before disabling verification, every run.
- The background process receives its config and tokens over IPC, never via argv or environment variables.
- The local control channel is bound to `127.0.0.1` and needs a random bearer token stored in the PID file (mode 0600).
