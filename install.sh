#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Install gather-spotify-status from GitHub Releases after verifying SHA256SUMS.
set -eu

# ---------------------------------------------------------------------------
# Configuration & environment overrides (GSS_* vars are primarily for CI/tests
# or custom install locations/versions)
# ---------------------------------------------------------------------------
APP_NAME="gather-spotify-status"
REPO="${GSS_REPO:-strund3r/gather-spotify-status}"
API_BASE="${GSS_GITHUB_API:-https://api.github.com}"
RELEASE_BASE="${GSS_RELEASE_BASE:-https://github.com}"
INSTALL_DIR="${GSS_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${GSS_VERSION:-}"

# Guard against malformed owner/repo strings before interpolating into URLs.
if ! printf '%s\n' "$REPO" | grep -Eq '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$'; then
  printf 'Error: invalid repository name: %s\n' "$REPO" >&2
  exit 1
fi

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

check_base_url "$API_BASE"
check_base_url "$RELEASE_BASE"

# ---------------------------------------------------------------------------
# OS & CPU architecture detection
# ---------------------------------------------------------------------------
UNAME_S="${GSS_UNAME_S:-$(uname -s)}"
case "$UNAME_S" in
  Linux) OS="linux" ;;
  Darwin) OS="darwin" ;;
  *)
    printf 'Error: unsupported OS: %s\n' "$UNAME_S" >&2
    exit 1
    ;;
esac

UNAME_M="${GSS_UNAME_M:-$(uname -m)}"
case "$UNAME_M" in
  x86_64|amd64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *)
    printf 'Error: unsupported architecture: %s\n' "$UNAME_M" >&2
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
if [ -z "$VERSION" ]; then
  # Enforce TLS >= 1.2 and HTTPS-only redirects against production GitHub.
  case "$API_BASE" in
    https://*)
      RELEASE_JSON="$(curl -fsSL --proto '=https' --tlsv1.2 -H 'Accept: application/vnd.github+json' -H "User-Agent: $APP_NAME" "${API_BASE}/repos/${REPO}/releases/latest")"
      ;;
    *)
      RELEASE_JSON="$(curl -fsSL -H 'Accept: application/vnd.github+json' -H "User-Agent: $APP_NAME" "${API_BASE}/repos/${REPO}/releases/latest")"
      ;;
  esac
  # Parse "tag_name" using POSIX tools (no jq dependency) and strip leading "v".
  VERSION="$(printf '%s\n' "$RELEASE_JSON" | tr ',' '\n' | sed -n 's/.*"tag_name"[ \t]*:[ \t]*"v\{0,1\}\([^"]*\)".*/\1/p' | head -n 1)"
else
  VERSION="${VERSION#v}"
fi

# Reject pre-release/malformed tags or path-traversal attempts before constructing URLs.
if ! printf '%s\n' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  printf 'Error: invalid or missing release version: %s\n' "$VERSION" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Download SHA256SUMS + target binary into an isolated temp directory
# ---------------------------------------------------------------------------
TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

ASSET="${APP_NAME}-v${VERSION}-${OS}-${ARCH}"
DOWNLOAD_BASE="${RELEASE_BASE}/${REPO}/releases/download/v${VERSION}"
SUMS_FILE="$TMP_DIR/SHA256SUMS"
ASSET_FILE="$TMP_DIR/$ASSET"

download_file() {
  url="$1"
  out="$2"
  case "$url" in
    https://*) curl -fsSL --proto '=https' --tlsv1.2 -H "User-Agent: $APP_NAME" -o "$out" "$url" ;;
    *) curl -fsSL -H "User-Agent: $APP_NAME" -o "$out" "$url" ;;
  esac
}

printf 'Downloading %s v%s (%s-%s)...\n' "$APP_NAME" "$VERSION" "$OS" "$ARCH"
download_file "${DOWNLOAD_BASE}/SHA256SUMS" "$SUMS_FILE"
download_file "${DOWNLOAD_BASE}/${ASSET}" "$ASSET_FILE"

# ---------------------------------------------------------------------------
# Verify SHA-256 digest before moving anything into $INSTALL_DIR
# ---------------------------------------------------------------------------
# Handles CRLF endings and both "<hash>  <file>" and "<hash> *<file>" formats.
EXPECTED_HASH="$(awk -v target="$ASSET" '{
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
}' "$SUMS_FILE")"

if ! printf '%s\n' "$EXPECTED_HASH" | grep -Eq '^[0-9a-f]{64}$'; then
  printf 'Error: could not find SHA-256 entry for %s in SHA256SUMS.\n' "$ASSET" >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_HASH="$(sha256sum "$ASSET_FILE" | awk '{print tolower($1)}')"
elif command -v shasum >/dev/null 2>&1; then
  ACTUAL_HASH="$(shasum -a 256 "$ASSET_FILE" | awk '{print tolower($1)}')"
elif command -v openssl >/dev/null 2>&1; then
  ACTUAL_HASH="$(openssl dgst -sha256 "$ASSET_FILE" | awk '{print tolower($NF)}')"
else
  printf 'Error: sha256sum, shasum, or openssl is required to verify downloads.\n' >&2
  exit 1
fi

if [ "$EXPECTED_HASH" != "$ACTUAL_HASH" ]; then
  printf 'Error: checksum verification failed for %s (expected %s, got %s).\n' "$ASSET" "$EXPECTED_HASH" "$ACTUAL_HASH" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Stage, adjust macOS attributes if needed, and atomically install
# ---------------------------------------------------------------------------
mkdir -p "$INSTALL_DIR"
STAGED="$INSTALL_DIR/${APP_NAME}.new.$$"
TARGET="$INSTALL_DIR/$APP_NAME"
cp "$ASSET_FILE" "$STAGED"
chmod 0755 "$STAGED"

if [ "$OS" = "darwin" ]; then
  # Clear Gatekeeper quarantine when present so Finder/curl downloads can run.
  if command -v xattr >/dev/null 2>&1; then
    xattr -d com.apple.quarantine "$STAGED" 2>/dev/null || true
  fi
  # Apple Silicon requires binaries to carry at least an ad-hoc code signature.
  if [ "$ARCH" = "arm64" ] && command -v codesign >/dev/null 2>&1; then
    codesign --sign - --force "$STAGED" 2>/dev/null || true
  fi
fi

mv -f "$STAGED" "$TARGET"
printf 'Installed %s v%s to %s\n' "$APP_NAME" "$VERSION" "$TARGET"

# ---------------------------------------------------------------------------
# Add $INSTALL_DIR to the user's shell PATH (skipped if already present or
# GSS_SKIP_PATH=1)
# ---------------------------------------------------------------------------
# Marker matches src/install.ts so self-install never appends a duplicate line.
PATH_MARKER="# added by $APP_NAME"
append_path_line() {
  rc_file="$1"
  rc_line="$2"
  if [ -f "$rc_file" ] && grep -Fq "$PATH_MARKER" "$rc_file"; then
    return 0
  fi
  mkdir -p "$(dirname "$rc_file")"
  if [ -f "$rc_file" ] && [ -s "$rc_file" ]; then
    printf '\n%s\n' "$rc_line" >> "$rc_file"
  else
    printf '%s\n' "$rc_line" >> "$rc_file"
  fi
  printf 'Added %s to PATH in %s (open a new terminal to use it).\n' "$INSTALL_DIR" "$rc_file"
}

if [ "${GSS_SKIP_PATH:-0}" != "1" ]; then
  case ":${PATH:-}:" in
    *":$INSTALL_DIR:"*) ;;
    *)
      SHELL_NAME="$(basename "${SHELL:-}")"
      case "$INSTALL_DIR" in
        "$HOME/.local/bin")
          DIR_EXPR='$HOME/.local/bin'
          FISH_DIR='~/.local/bin'
          ;;
        *)
          DIR_EXPR="$INSTALL_DIR"
          FISH_DIR="$INSTALL_DIR"
          ;;
      esac
      EXPORT_LINE="export PATH=\"$DIR_EXPR:\$PATH\"  $PATH_MARKER"
      XDG_CFG="${XDG_CONFIG_HOME:-$HOME/.config}"

      case "$SHELL_NAME" in
        zsh)
          append_path_line "${ZDOTDIR:-$HOME}/.zshrc" "$EXPORT_LINE"
          ;;
        bash)
          append_path_line "$HOME/.bashrc" "$EXPORT_LINE"
          # macOS login shells read ~/.bash_profile instead of ~/.bashrc.
          if [ "$OS" = "darwin" ]; then
            append_path_line "$HOME/.bash_profile" "$EXPORT_LINE"
          fi
          ;;
        fish)
          append_path_line "$XDG_CFG/fish/conf.d/${APP_NAME}.fish" "fish_add_path $FISH_DIR  $PATH_MARKER"
          ;;
        *)
          append_path_line "$HOME/.profile" "$EXPORT_LINE"
          ;;
      esac
      ;;
  esac
fi

printf 'Run "%s" to get started.\n' "$APP_NAME"
