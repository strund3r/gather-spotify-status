# gather-spotify-status

[![codecov](https://codecov.io/github/strund3r/gather-spotify-status/graph/badge.svg?token=A73JIEN17X)](https://codecov.io/github/strund3r/gather-spotify-status)

Sets your [Gather](https://gather.town) status to the track you're playing on Spotify (🎶 _Artist ∙ Song_), or 🎙️ when you're listening to a podcast. When nothing is playing, your status is cleared.

It ships as a single executable. You don't need Node.js, npm or anything else installed.

## Download / install

Pick the binary for your platform:

| Platform            | File                                           |
| ------------------- | ---------------------------------------------- |
| Linux x64           | `gather-spotify-status-v<ver>-linux-x64`       |
| Linux ARM64         | `gather-spotify-status-v<ver>-linux-arm64`     |
| macOS Apple Silicon | `gather-spotify-status-v<ver>-darwin-arm64`    |
| macOS Intel         | `gather-spotify-status-v<ver>-darwin-x64`      |
| Windows x64         | `gather-spotify-status-v<ver>-windows-x64.exe` |

Verify the download against `SHA256SUMS`:

```sh
sha256sum -c SHA256SUMS --ignore-missing      # Linux
shasum -a 256 -c SHA256SUMS --ignore-missing  # macOS
```

```powershell
Get-FileHash .\gather-spotify-status-v*-windows-x64.exe  # Windows: compare with SHA256SUMS
```

On Linux/macOS, make it executable: `chmod +x gather-spotify-status-*`

**macOS:** the binaries are not signed by Apple.

- If macOS blocks the file ("cannot be opened because the developer cannot be verified"), run `xattr -d com.apple.quarantine gather-spotify-status-v*-darwin-*`.
- If the Apple Silicon binary is killed as soon as it starts, ad-hoc sign it: `codesign --sign - gather-spotify-status-v*-darwin-arm64`.
- Only do this for a binary whose checksum you verified.

### It installs itself

Run the downloaded file once. It **moves itself** to a per-user folder, renames itself to `gather-spotify-status`, and adds that folder to your PATH. No sudo or admin rights are needed.

| OS            | Installed to                                                              | PATH updated in                                                                        |
| ------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Linux / macOS | `~/.local/bin/gather-spotify-status`                                      | `~/.zshrc`, `~/.bashrc` (+ `~/.bash_profile` on macOS), fish `conf.d`, or `~/.profile` |
| Windows       | `%LOCALAPPDATA%\Programs\gather-spotify-status\gather-spotify-status.exe` | your user `Path` environment variable                                                  |

The PATH line is marked `# added by gather-spotify-status` and is added only once. If the folder is already on your PATH, nothing is changed. **Open a new terminal** afterwards; from then on just run `gather-spotify-status` from anywhere.

**Upgrading:** download the new version and run it once. If it's newer than the installed copy, it replaces it. A copy running in the background is stopped first. Running the same or an older version doesn't change the installed copy.

On Windows a running `.exe` can't delete itself, so the downloaded file is copied instead of moved; delete it yourself afterwards.

Use `--no-install` to run a copy where it is, without installing. `gather-spotify-status --version` shows the installed version.

## What you need before the first run

On first run the app asks for 4 values. Here's how to get each of them.

> Tip: `gather-spotify-status --readme` opens this README as a PDF, even offline.

### 1. Gather API key (`GATHER_API_KEY`)

1. Log in to Gather in your browser.
2. Open <https://gather.town/apiKeys>.
3. Click **Generate new key** and copy it.

> The key gives full access to your Gather account. Treat it like a password and never share it. If it leaks, delete it on the same page and generate a new one.

### 2. Gather space ID (`GATHER_SPACE_ID`)

1. Open your space in the browser. The URL looks like:

   ```
   https://app.gather.town/app/aBcD1234eFgH5678/My%20Office
   ```
2. The space ID is everything after `/app/`, with `%20` turned back into spaces:

   ```
   aBcD1234eFgH5678/My Office
   ```

### 3. Spotify client ID and secret (`SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`)

You create your own (free) Spotify developer app:

1. Go to <https://developer.spotify.com/dashboard> and log in with your Spotify account. Accept the developer terms if asked.
2. Click **Create app** and fill in:
   - **App name:** anything, e.g. `gather-spotify-status`
   - **App description:** anything
   - **Redirect URI:** `http://127.0.0.1:42843/callback`. It must match exactly. Click **Add**.
   - **Which API/SDKs are you planning to use?** tick **Web API**
3. Accept the terms and click **Save**.
4. Open the app and click **Settings**:
   - Copy the **Client ID**.
   - Click **View client secret** and copy the **Client secret**.
5. New apps run in _Development mode_. Since 2026 Spotify allows **at most 5 users** per app, the app owner needs **Spotify Premium**, and every user must be added under **User Management** (name + Spotify email), including yourself. Users who aren't on that list get `403` errors.

> Keep the client secret private. If it leaks, open the app's **Settings** and click **Rotate client secret**.

The app asks Spotify for two read-only permissions: `user-read-currently-playing` (what's playing) and `user-read-playback-state` (to detect private sessions).

## Running

```sh
./gather-spotify-status-v1.0.0-linux-x64 # very first time: the downloaded file (it installs itself)
gather-spotify-status                    # afterwards, from any new terminal
```

**First run:**

1. The app installs itself (see above).
2. It asks for the 4 values above. The API key and client secret are masked as you type.
3. They are saved like this (see [Where your secrets are stored](#where-your-secrets-are-stored)):
   - The **Gather API key and Spotify client secret** go to your OS keychain.
   - The **space ID and client ID** (not secret) go to the config file:
     - Linux/macOS: `~/.config/gather-spotify-status/config.json` (or `$XDG_CONFIG_HOME/...`), readable only by you.
     - Windows: `%APPDATA%\gather-spotify-status\config.json`
4. Your browser opens `http://127.0.0.1:42843`, which takes you to Spotify's login page. If the browser doesn't open, open that URL yourself.
5. After you approve, the tab shows _"Logged in to Spotify"_ and tries to close itself. Browsers often block that (Firefox always does; Chrome does on a first login), so then it just says _"You can close this tab now."_
6. The app connects to Gather and **moves to the background**, so you get your terminal back:

   ```text
   ✓ Logged in to Spotify.
   Connecting to Gather...
   ✓ Running in background (PID 12345)
     Logs:   ~/.config/gather-spotify-status/gather-spotify-status.log
     Status: gather-spotify-status --status
     Stop:   gather-spotify-status --stop
   ```

Your Gather status now follows Spotify, checked every 5 seconds. The status is only sent to Gather when it changes. Closing the terminal doesn't stop the app.

### Staying logged in

After the first browser login, your Spotify login (a refresh token) is saved in the OS keychain, or in the config file if no keychain is available. Later runs reuse it without opening the browser:

```text
✓ Logged in to Spotify. (saved login)
```

If the saved login stops working (you removed the app's access in your Spotify account, or Spotify expired it), the app tells you and opens the browser login again. `gather-spotify-status --logout` forgets the saved login and stops a running copy.

### It keeps running

The background copy doesn't give up on errors:

- **Expired access tokens** are refreshed automatically, including after your laptop wakes from sleep.
- **Network problems and Spotify outages:** it retries with increasing waits (5 s, 10 s, 20 s … up to 5 min) and recovers on its own.
- **Spotify rate limits (`429`):** it waits as long as Spotify asks.
- **Gather disconnects:** the Gather SDK reconnects, and your status is resent.
- **Revoked login:** it clears your status and waits. `--status` shows _"Spotify login expired"_; run `gather-spotify-status` again to log in.

### Start at login

The first time it starts, the app asks once whether to start automatically when you log in (default: no), and shows how to change that later. It doesn't ask again, also not if you already used `--autostart on` / `off`. Change it any time:

```sh
gather-spotify-status --autostart on       # start automatically when you log in to your computer
gather-spotify-status --autostart status
gather-spotify-status --autostart off
```

| OS      | How                                                                                 |
| ------- | ----------------------------------------------------------------------------------- |
| Linux   | `~/.config/autostart/gather-spotify-status.desktop` (GNOME, KDE and other desktops) |
| macOS   | `~/Library/LaunchAgents/com.gather-spotify-status.plist`                            |
| Windows | `HKCU\...\CurrentVersion\Run` registry value                                        |

At login it waits ~20 s for the network, then starts silently using your saved Spotify login. If there is none, your browser opens to log in. If it's already running, it does nothing.

### Checking, pausing, stopping

```sh
gather-spotify-status --status    # ● Running v1.0.0 (PID 12345) · connected   + what your status shows
gather-spotify-status --pause     # clear your Gather status until you resume (e.g. for a meeting)
gather-spotify-status --resume
gather-spotify-status --stop      # clears your Gather status and stops it (also on Windows)
```

Only one copy runs at a time. Starting another says `Already running ... Stop it with: gather-spotify-status --stop`. A pause lasts until `--resume` or until the app restarts.

To stay in the terminal instead (Ctrl+C to stop), use `--foreground`.

## Settings

Change how your status looks and when it shows, with `--set key=value`. A running copy picks up changes immediately, with no restart needed. `--get` lists all settings with their current values.

```sh
gather-spotify-status --get
gather-spotify-status --set statusFormat="{artist} – {track}"
gather-spotify-status --set workHours="Mon-Fri 09:00-18:00"
gather-spotify-status --set blockArtists="Nickelback,Some Guilty Pleasure"
```

| Setting              | Default                             | What it does                                                                                                               |
| -------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `statusFormat`       | `{artist} ∙ {track} (Spotify)`      | Text for music. Placeholders: `{artist}` (first), `{artists}` (all), `{track}`, `{album}`                                  |
| `podcastFormat`      | `Listening to a podcast on Spotify` | Text for podcasts. Placeholders: `{show}`, `{episode}`                                                                     |
| `musicEmoji`         | 🎶                                  | Emoji for music (empty for none)                                                                                           |
| `podcastEmoji`       | 🎙️                                  | Emoji for podcasts (empty for none)                                                                                        |
| `maxLength`          | `100`                               | Shorten longer text with `…` (`0` = no limit)                                                                              |
| `blockArtists`       | _(none)_                            | Comma-separated artists that never show; your status is cleared instead                                                    |
| `workHours`          | `off`                               | Only show a status in these hours, e.g. `Mon-Fri 09:00-18:00`, `Mon,Wed,Fri 08:30-17:00`, `Daily 09:00-22:00`. Local time. |
| `skipPrivateSession` | `true`                              | Show nothing while a Spotify private session is on                                                                         |
| `debug`              | `false`                             | Verbose logging (every poll and status update)                                                                             |

Settings are stored in the `"settings"` section of `config.json`. Invalid values are rejected with an explanation.

**Privacy summary:** nothing is shown when you pause, outside `workHours`, during a private session, or for a blocked artist. In each case your Gather status is cleared, so nobody can tell why.

## Logs and debugging

All details go to the log file, next to the config:

- the Gather SDK's own messages (`[warn from gs] ...`, `connecting to ...`), tagged `[gather ...]`,
- token refreshes, retries, reconnects and errors while running in the background.

The terminal shows only the app's own messages. The log is readable only by you, never contains tokens or secrets, and is rotated at 5 MB (one old copy kept as `.log.1`).

```sh
gather-spotify-status --logs          # last 50 lines, then follows new ones (Ctrl+C to stop)
gather-spotify-status --logs -n 200
gather-spotify-status --debug         # start with verbose logging (or: --set debug=true)
```

## Updates

`gather-spotify-status --check-update` checks for a newer release, and the app also checks at most once a day when it starts. It only tells you; it never downloads anything by itself. To upgrade, download the new binary and run it once (see [It installs itself](#it-installs-itself)).

> The update check is switched off in this build until the project's release repository is configured (`REPO` in `update.ts`).

### Options

```text
Running instance:
  --status            Show whether it's running, what it's showing, where the logs are
  --stop              Stop it (and clear your Gather status)
  --pause / --resume  Temporarily clear your status / show it again
  --logs [-n N]       Show the last N log lines (default 50) and follow new ones
  --foreground        Stay in this terminal instead of going to the background (Ctrl+C to stop)
  --debug             Verbose logging (every poll and status update)

Settings (applied immediately to a running instance):
  --get [key]         Show settings
  --set key=value     Change a setting

Setup:
  --autostart on|off|status  Start automatically when you log in to your computer
  --logout            Forget the saved Spotify login
  --reset             Delete saved config and secrets, and prompt again
  --config-path       Print the config file location
  --readme            Open this README as a PDF (offline copy built into the app)
  --check-update      Check for a newer version
  --insecure          Disable TLS verification without asking (only if TLS checks fail)
  --no-install        Run this copy as-is; don't install/upgrade it
  -v, --version       Print the version
  -h, --help          Show help
```

### Environment variables

Instead of the config file, you can pass the values as environment variables, which is handy for scripts. Env vars take priority, and they are never written to disk.

```sh
GATHER_API_KEY=... GATHER_SPACE_ID='abc123/My Office' \
SPOTIFY_CLIENT_ID=... SPOTIFY_CLIENT_SECRET=... gather-spotify-status
```

If values are missing and no terminal is attached, the app exits with an error and lists the missing values. It doesn't wait for input.

## TLS / corporate proxies (Netskope)

At startup the app checks that it can securely reach Spotify and Gather.

If a certificate error occurs, it's usually corporate TLS inspection such as Netskope. The app then works through these steps:

1. **Netskope CA.** It looks for the Netskope root CA in its standard location:
   - Linux: `/opt/netskope/stagent/data/nscacert.pem`
   - macOS: `/Library/Application Support/Netskope/STAgent/data/nscacert.pem`
   - Windows: `C:\ProgramData\netskope\stagent\data\nscacert.pem`

   If it finds one, it restarts trusting that CA. TLS verification stays **on**.
2. **Ask.** If that doesn't help, the app explains the problem and asks: `Disable TLS verification for this run? [y/N]`.
   - It asks on every run and never remembers the answer.
   - The default is **No**.
   - While verification is off, traffic including your Gather API key and Spotify secret/tokens could be read by anyone intercepting the connection.
3. **No terminal.** Without a terminal, the app exits unless you pass `--insecure` (or `GSS_INSECURE_TLS=1`).

**Better fix:** keep verification on by pointing the app at your corporate root CA (PEM file). Ask IT for it if you don't know where it is.

```sh
NODE_EXTRA_CA_CERTS=/path/to/corp-root-ca.pem gather-spotify-status
```

## Troubleshooting

- **First stop: `gather-spotify-status --status` and `--logs`.** Most problems are explained there.
- **`gather-spotify-status: command not found` after installing:** open a new terminal so it picks up the PATH change. You can also run it via its full path, `~/.local/bin/gather-spotify-status`.
- **`Port 42843 is already in use`:** another copy is running (perhaps an old one started with `--no-install` or from source). Stop it first.
- **`Could not start in the background: no connection after 30s`:** Gather didn't connect. Check the log, then `GATHER_SPACE_ID` and `GATHER_API_KEY` (fix them with `--reset`).
- **Spotify login says `INVALID_CLIENT: Invalid redirect URI`:** the redirect URI in your Spotify app must be exactly `http://127.0.0.1:42843/callback`.
- **Spotify login works but nothing shows up / 403 in the log:** add your Spotify account under **User Management** in the developer dashboard (max 5 users), and make sure the app owner has Spotify Premium.
- **`--status` says "Spotify login expired":** run `gather-spotify-status` to log in again.
- **Status doesn't show at certain times:** check `workHours`, `blockArtists` and `skipPrivateSession` with `--get`, and whether you paused it (`--status`).
- **The log keeps saying "Disconnected from Gather":** check `GATHER_SPACE_ID` (both parts, with spaces, not `%20`) and `GATHER_API_KEY`. Fix them with `--reset`.
- **Wrong values saved:** run with `--reset`.

## Where your secrets are stored

The two secrets (`GATHER_API_KEY`, `SPOTIFY_CLIENT_SECRET`) are kept in your **OS keychain**, encrypted at rest and unlocked with your login session:

| OS      | Keychain                                 | View / remove the entries                                                |
| ------- | ---------------------------------------- | ------------------------------------------------------------------------ |
| macOS   | Keychain (login)                         | _Keychain Access_ app → search `gather-spotify-status`                   |
| Windows | Credential Manager                       | _Credential Manager_ → Windows Credentials → `gather-spotify-status/...` |
| Linux   | Secret Service (GNOME Keyring / KWallet) | `secret-tool search --all service gather-spotify-status` (or _Seahorse_) |

Only non-secret values stay in `config.json`, which also records `"secretStorage": "keychain"`. `gather-spotify-status --status` shows where yours are.

- **Secrets found in `config.json`** (e.g. hand-written, or saved while no keychain was available) are moved into the keychain automatically on the next run, which prints `✓ Moved ... to <keychain>`.
- **No keychain available** (headless or SSH Linux without a desktop session): the secrets stay in `config.json`, readable only by you. The app tells you, and moves them into the keychain later once one is available.
- **macOS:** after an upgrade, macOS may ask once whether _gather-spotify-status_ may access its keychain item, because the binary changed. Choose **Always Allow**.
- **Env vars:** secrets passed as environment variables are used as-is and never stored anywhere, which suits password managers (`GATHER_API_KEY=$(pass show gather/api-key) gather-spotify-status`).
- `--reset` deletes the keychain entries as well as the config file.
- If the config folder or file ever becomes readable by other users, the app tightens it back to `0700`/`0600` and tells you.

## Security notes

- The local login server listens only on `127.0.0.1`, so other machines can't reach it.
- The Spotify login uses a random `state` value and PKCE, so a forged or intercepted login callback is rejected.
- Logs never include tokens or `Authorization` headers.
- The background process gets its config and tokens privately from the launcher, never via command-line arguments or environment variables, so they don't show up in `ps` or `/proc`.
- The saved Spotify login (refresh token) lives in the OS keychain like the other secrets. It only allows reading what you're playing. `--logout` deletes it.
- `--stop`, `--pause`, `--resume` and `--set` talk to the running copy over `127.0.0.1` with a random per-run token, stored in the PID file and readable only by you, so other users on the machine can't control it.
- The keychain protects secrets at rest (backups, cloud sync, a stolen disk). It can't stop malware already running as you while you're logged in.

## Build from source

Requirements:

- [Bun](https://bun.sh) ≥ 1.4, to run, test and compile (the version used is pinned in `.tool-versions`).
- [Node.js + npm](https://nodejs.org) ≥ 22, for installing dependencies, the type check, Biome and the build scripts.
- Google Chrome, Chromium or Microsoft Edge, to render `README.md` → `assets/README.pdf`, which is embedded for `--readme`. If it isn't found automatically, set `CHROME_PATH=/path/to/chrome`.

```sh
npm ci                  # install the exact locked dependencies
npm run dev -- --status # run from source with Bun (any flags after --)
npm run check           # type check + lint + tests
npm run lint:fix        # apply Biome formatting and safe lint fixes
npm run test:coverage   # tests with a coverage report (coverage/lcov.info)
npm run build           # checks + binary for your platform -> bin/gather-spotify-status[.exe]
npm run build:all       # checks + all 5 platforms + bin/SHA256SUMS
npm run readme:pdf      # only regenerate assets/README.pdf
```

Source lives in `src/`, tests in `test/`. Running from source needs Bun, not Node: the app uses Bun's built-in keychain (`Bun.secrets`) and `WebSocket`.

Running a freshly built binary moves it out of `bin/` and installs it. Pass `--no-install` while developing.

To release a new version, bump `version` in `package.json` (the app reads it from there), add an entry to `CHANGELOG.md`, and push a `v<version>` tag. The release workflow then builds and publishes the binaries.

`build:all` downloads the Bun runtime for each target platform the first time, so it needs network access.

## Further information

- [Gather Websocket API docs](https://gathertown.notion.site/Gather-Websocket-API-bf2d5d4526db412590c3579c36141063)
- [Spotify: Authorization Code Flow](https://developer.spotify.com/documentation/web-api/tutorials/code-flow)
- [Spotify: Get Currently Playing Track](https://developer.spotify.com/documentation/web-api/reference/get-the-users-currently-playing-track)

## AI Assistance

AI tools were used to assist in the development of this project. All generated code was reviewed, verified, and tested.

## License

[GNU General Public License v3.0 or later](LICENSE) (GPL-3.0-or-later). You may use, change and share it; if you distribute a modified version, it must be under the same license, with its source code available.
