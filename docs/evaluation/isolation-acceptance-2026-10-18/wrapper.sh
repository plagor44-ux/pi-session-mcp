#!/bin/sh
# Coding-only pi-session-mcp boundary for writer psm-alpha (ADR 0008 option 1). Stdout is reserved for MCP frames.
STATE="$HOME/pi-writers/psm-alpha"
CLONE="$STATE/clone"
RELEASE="$HOME/.local/lib/node_modules/pi-session-mcp"
IMAGE="docker.io/library/node@sha256:c4d5523090a817b7aa86d2111241fdd4f66d1e27782b44160e6aa63b357ecb2d"
NETWORK="${PI_WRITER_NETWORK:-pasta}"
if [ "$#" -eq 0 ]; then set -- node /opt/pi-session-mcp/dist/main.js; fi
exec podman run -i --rm \
  --userns=keep-id \
  --read-only \
  --cap-drop=all --security-opt=no-new-privileges \
  --network="$NETWORK" \
  --tmpfs /tmp:rw,nosuid,nodev,size=512m \
  --tmpfs /pi/home:rw,nosuid,nodev,mode=0700,size=64m,U \
  -v "$CLONE:$CLONE:rw" \
  -v "$CLONE/.git/hooks:$CLONE/.git/hooks:ro" \
  -v "$CLONE/.git/config:$CLONE/.git/config:ro" \
  -v "$RELEASE:/opt/pi-session-mcp:ro" \
  -v "$STATE/pi-session-mcp.json:/pi/config.json:ro" \
  -v "$STATE/agent:/pi/agent:rw" \
  --workdir "$CLONE" \
  -e HOME=/pi/home \
  -e PI_SESSION_MCP_CONFIG=/pi/config.json \
  -e PI_CODING_AGENT_DIR=/pi/agent \
  "$IMAGE" "$@"
