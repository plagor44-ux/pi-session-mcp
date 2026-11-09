#!/bin/sh
set -eu

VERSION="0.19.1"

case "$(uname -s)" in
  Linux|Darwin) ;;
  *) echo "platform_unsupported" >&2; exit 1 ;;
esac

NODE_VERSION=$(node --version 2>/dev/null) || NODE_VERSION=""
if ! printf '%s' "$NODE_VERSION" | node -e '
let s = ""; process.stdin.on("data", c => s += c); process.stdin.on("end", () => {
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (!m || Number(m[1]) < 22 || (Number(m[1]) === 22 && Number(m[2]) < 19)) process.exit(1);
});' ; then
  echo "node_version_unsupported" >&2
  exit 1
fi

NPM_JSON=$(npm ls -g --depth=0 --json pi-session-mcp 2>/dev/null) || :
if ! INSTALLED=$(printf '%s' "$NPM_JSON" | node -e '
let s = ""; process.stdin.on("data", c => s += c); process.stdin.on("end", () => {
  try { const d = JSON.parse(s).dependencies?.["pi-session-mcp"]; if (d && typeof d.version !== "string") process.exit(1); process.stdout.write(d?.version ?? ""); }
  catch { process.exit(1); }
});'); then
  echo "installed_version_unavailable" >&2
  exit 1
fi
if [ -n "$INSTALLED" ] && [ "$INSTALLED" != "$VERSION" ]; then
  echo "upgrade_required: see https://github.com/plagor44-ux/pi-session-mcp/blob/main/docs/installation.md#upgrade" >&2
  exit 1
fi
if [ -z "$INSTALLED" ]; then
  npm install -g "pi-session-mcp@$VERSION"
fi
PREFIX=$(npm prefix -g) || PREFIX=""
if [ -n "$PREFIX" ] && [ -x "$PREFIX/bin/pi-session-mcp-setup" ]; then
  exec "$PREFIX/bin/pi-session-mcp-setup" --guided --apply "$@"
fi
if command -v pi-session-mcp-setup >/dev/null 2>&1; then
  exec pi-session-mcp-setup --guided --apply "$@"
fi
echo "setup_not_found: add the npm global bin directory to PATH and run this script again" >&2
exit 1
