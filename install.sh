#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Install gather-spotify-status from GitHub Releases after verifying SHA256SUMS.
set -eu

APP_NAME="gather-spotify-status"
# Marker matches src/install.ts so self-install never appends a duplicate line.
PATH_MARKER="# added by $APP_NAME"
TMP_DIR=""

cleanup() {
  if [ -n "${TMP_DIR:-}" ]; then
    rm -rf "$TMP_DIR"
  fi
}

# Require HTTPS in normal usage; only allow loopback HTTP when mock endpoints
# are explicitly injected via GSS_GITHUB_API / GSS_RELEASE_BASE.
check_base_url() {
  case "$1" in
    https://*) return 0 ;;
    http://127.0.0.1:*|http://localhost:*)
      if [ -n "${GSS_GITHUB_API:-}" ] || [ -n "${GSS_RELEASE_BASE:-}" ]; then
        return 0
      fi
      ;;
  esac
  printf 'Error: insecure URL scheme: %s\n' "$1" >&2
  exit 1
}

download_file() {
  case "$1" in
    https://*) curl -fsSL --proto '=https' --tlsv1.2 -H "User-Agent: $APP_NAME" -o "$2" "$1" ;;
    *) curl -fsSL -H "User-Agent: $APP_NAME" -o "$2" "$1" ;;
  esac
}

append_path_line() {
  rc_file="$1"
  rc_line="$2"
  install_dir="$3"
  if [ -f "$rc_file" ] && grep -Fq "$PATH_MARKER" "$rc_file"; then
    return 0
  fi
  mkdir -p "$(dirname "$rc_file")"
  if [ -f "$rc_file" ] && [ -s "$rc_file" ]; then
    printf '\n%s\n' "$rc_line" >> "$rc_file"
  else
    printf '%s\n' "$rc_line" >> "$rc_file"
  fi
  printf 'Added %s to PATH in %s (open a new terminal to use it).\n' "$install_dir" "$rc_file"
}

# Wrap execution in main() so "curl ... | sh" never runs a truncated download.
main() {
  # ---------------------------------------------------------------------------
  # Configuration & environment overrides (GSS_* vars are primarily for
  # CI/tests or custom install locations/versions)
  # ---------------------------------------------------------------------------
  repo="${GSS_REPO:-strund3r/gather-spotify-status}"
  api_base="${GSS_GITHUB_API:-https://api.github.com}"
  release_base="${GSS_RELEASE_BASE:-https://github.com}"
  install_dir="${GSS_INSTALL_DIR:-$HOME/.local/bin}"
  version="${GSS_VERSION:-}"

  # Guard against malformed owner/repo strings before interpolating into URLs.
  if ! printf '%s\n' "$repo" | grep -Eq '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$'; then
    printf 'Error: invalid repository name: %s\n' "$repo" >&2
    exit 1
  fi

  check_base_url "$api_base"
  check_base_url "$release_base"

  # ---------------------------------------------------------------------------
  # OS & CPU architecture detection
  # ---------------------------------------------------------------------------
  uname_s="${GSS_UNAME_S:-$(uname -s)}"
  case "$uname_s" in
    Linux) os="linux" ;;
    Darwin) os="darwin" ;;
    *)
      printf 'Error: unsupported OS: %s\n' "$uname_s" >&2
      exit 1
      ;;
  esac

  uname_m="${GSS_UNAME_M:-$(uname -m)}"
  case "$uname_m" in
    x86_64|amd64) arch="x64" ;;
    aarch64|arm64) arch="arm64" ;;
    *)
      printf 'Error: unsupported architecture: %s\n' "$uname_m" >&2
      exit 1
      ;;
  esac

  if ! command -v curl >/dev/null 2>&1; then
    printf 'Error: curl is required.\n' >&2
    exit 1
  fi

  # ---------------------------------------------------------------------------
  # Release version resolution & strict SemVer check
  # ---------------------------------------------------------------------------
  if [ -z "$version" ]; then
    # Enforce TLS >= 1.2 and HTTPS-only redirects against production GitHub.
    case "$api_base" in
      https://*)
        release_json="$(curl -fsSL --proto '=https' --tlsv1.2 -H 'Accept: application/vnd.github+json' -H "User-Agent: $APP_NAME" "${api_base}/repos/${repo}/releases/latest")"
        ;;
      *)
        release_json="$(curl -fsSL -H 'Accept: application/vnd.github+json' -H "User-Agent: $APP_NAME" "${api_base}/repos/${repo}/releases/latest")"
        ;;
    esac
    # Parse "tag_name" using POSIX tools (no jq dependency) and strip leading "v".
    version="$(printf '%s\n' "$release_json" | tr ',' '\n' | sed -n 's/.*"tag_name"[ \t]*:[ \t]*"v\{0,1\}\([^"]*\)".*/\1/p' | head -n 1)"
  else
    version="${version#v}"
  fi

  # Reject pre-release/malformed tags or path-traversal attempts before constructing URLs.
  if ! printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    printf 'Error: invalid or missing release version: %s\n' "$version" >&2
    exit 1
  fi

  # ---------------------------------------------------------------------------
  # Download SHA256SUMS + target binary into an isolated temp directory
  # ---------------------------------------------------------------------------
  TMP_DIR="$(mktemp -d)"
  trap cleanup EXIT INT TERM

  asset="${APP_NAME}-v${version}-${os}-${arch}"
  download_base="${release_base}/${repo}/releases/download/v${version}"
  sums_file="$TMP_DIR/SHA256SUMS"
  asset_file="$TMP_DIR/$asset"

  printf 'Downloading %s v%s (%s-%s)...\n' "$APP_NAME" "$version" "$os" "$arch"
  download_file "${download_base}/SHA256SUMS" "$sums_file"
  download_file "${download_base}/${asset}" "$asset_file"

  # ---------------------------------------------------------------------------
  # Verify SHA-256 digest before moving anything into $install_dir
  # ---------------------------------------------------------------------------
  # Handles CRLF endings and both "<hash>  <file>" and "<hash> *<file>" formats.
  expected_hash="$(awk -v target="$asset" '{
    sub(/\r$/, "");
    line = $0;
    sub(/^[ \t]+/, "", line);
    if (line ~ /^[0-9a-fA-F]{64}[ \t]+\*?/) {
      h = tolower(substr(line, 1, 64));
      f = substr(line, 65);
      sub(/^[ \t]+\*?/, "", f);
      sub(/[ \t]+$/, "", f);
      if (f == target) { print h; exit 0 }
    }
  }' "$sums_file")"

  if ! printf '%s\n' "$expected_hash" | grep -Eq '^[0-9a-f]{64}$'; then
    printf 'Error: could not find SHA-256 entry for %s in SHA256SUMS.\n' "$asset" >&2
    exit 1
  fi

  if command -v sha256sum >/dev/null 2>&1; then
    actual_hash="$(sha256sum "$asset_file" | awk '{print tolower($1)}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual_hash="$(shasum -a 256 "$asset_file" | awk '{print tolower($1)}')"
  elif command -v openssl >/dev/null 2>&1; then
    actual_hash="$(openssl dgst -sha256 "$asset_file" | awk '{print tolower($NF)}')"
  else
    printf 'Error: sha256sum, shasum, or openssl is required to verify downloads.\n' >&2
    exit 1
  fi

  if [ "$expected_hash" != "$actual_hash" ]; then
    printf 'Error: checksum verification failed for %s (expected %s, got %s).\n' "$asset" "$expected_hash" "$actual_hash" >&2
    exit 1
  fi

  # ---------------------------------------------------------------------------
  # Stage, adjust macOS attributes if needed, and atomically install
  # ---------------------------------------------------------------------------
  mkdir -p "$install_dir"
  staged="$install_dir/${APP_NAME}.new.$$"
  target="$install_dir/$APP_NAME"
  cp "$asset_file" "$staged"
  chmod 0755 "$staged"

  if [ "$os" = "darwin" ]; then
    # Clear Gatekeeper quarantine when present so Finder/curl downloads can run.
    if command -v xattr >/dev/null 2>&1; then
      xattr -d com.apple.quarantine "$staged" 2>/dev/null || true
    fi
    # Apple Silicon requires binaries to carry at least an ad-hoc code signature.
    if [ "$arch" = "arm64" ] && command -v codesign >/dev/null 2>&1; then
      codesign --sign - --force "$staged" 2>/dev/null || true
    fi
  fi

  mv -f "$staged" "$target"
  printf 'Installed %s v%s to %s\n' "$APP_NAME" "$version" "$target"

  # ---------------------------------------------------------------------------
  # Add $install_dir to the user's shell PATH (skipped if already present or
  # GSS_SKIP_PATH=1)
  # ---------------------------------------------------------------------------
  if [ "${GSS_SKIP_PATH:-0}" != "1" ]; then
    case ":${PATH:-}:" in
      *":$install_dir:"*) ;;
      *)
        shell_name="$(basename "${SHELL:-}")"
        case "$install_dir" in
          "$HOME/.local/bin")
            dir_expr='$HOME/.local/bin'
            fish_dir='~/.local/bin'
            ;;
          *)
            dir_expr="$install_dir"
            fish_dir="$install_dir"
            ;;
        esac
        export_line="export PATH=\"$dir_expr:\$PATH\"  $PATH_MARKER"
        xdg_cfg="${XDG_CONFIG_HOME:-$HOME/.config}"

        case "$shell_name" in
          zsh)
            append_path_line "${ZDOTDIR:-$HOME}/.zshrc" "$export_line" "$install_dir"
            ;;
          bash)
            append_path_line "$HOME/.bashrc" "$export_line" "$install_dir"
            # macOS login shells read ~/.bash_profile instead of ~/.bashrc.
            if [ "$os" = "darwin" ]; then
              append_path_line "$HOME/.bash_profile" "$export_line" "$install_dir"
            fi
            ;;
          fish)
            append_path_line "$xdg_cfg/fish/conf.d/${APP_NAME}.fish" "fish_add_path $fish_dir  $PATH_MARKER" "$install_dir"
            ;;
          *)
            append_path_line "$HOME/.profile" "$export_line" "$install_dir"
            ;;
        esac
        ;;
    esac
  fi

  printf 'Run "%s" to get started.\n' "$APP_NAME"
}

main "$@"
