#!/usr/bin/env bash
# Installs (or upgrades) the tabby-serial-mcp Tabby plugin from a GitHub release.
#
#   curl -fsSL https://raw.githubusercontent.com/Wazy-XD/tabby-serial-mcp/main/scripts/install.sh | bash
#
# Environment:
#   REPO=owner/name   default Wazy-XD/tabby-serial-mcp
#   VERSION=tag       default latest
set -euo pipefail

REPO="${REPO:-Wazy-XD/tabby-serial-mcp}"
VERSION="${VERSION:-latest}"

if [ "$VERSION" = "latest" ]; then
    URL="https://github.com/$REPO/releases/latest/download/tabby-serial-mcp.tar.gz"
else
    URL="https://github.com/$REPO/releases/download/$VERSION/tabby-serial-mcp.tar.gz"
fi

case "$(uname -s)" in
    Darwin) USER_DATA="$HOME/Library/Application Support/tabby" ;;
    *)      USER_DATA="${XDG_CONFIG_HOME:-$HOME/.config}/tabby" ;;
esac

PLUGINS_ROOT="$USER_DATA/plugins/node_modules"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "downloading $URL"
curl -fsSL "$URL" -o "$TMP/plugin.tar.gz"
tar -xzf "$TMP/plugin.tar.gz" -C "$TMP"

if [ ! -d "$TMP/tabby-serial-mcp" ]; then
    echo "unexpected archive layout" >&2
    exit 1
fi

mkdir -p "$PLUGINS_ROOT"
rm -rf "${PLUGINS_ROOT:?}/tabby-serial-mcp"
cp -R "$TMP/tabby-serial-mcp" "$PLUGINS_ROOT/tabby-serial-mcp"

echo "installed -> $PLUGINS_ROOT/tabby-serial-mcp"
echo "restart Tabby to load the plugin, then check http://127.0.0.1:3002/health"
