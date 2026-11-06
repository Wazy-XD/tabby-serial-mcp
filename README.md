# tabby-serial-mcp

**English** · [中文](README.zh-CN.md)

An [MCP](https://modelcontextprotocol.io) bridge for [Tabby](https://tabby.sh) that lets an AI agent
read and write **raw bytes on the serial tabs you already have open** — and open new ones.

The point is what it does *not* do: it never opens a second COM port. It attaches to the live
`SerialSession` Tabby already owns, so you and the agent share one connection. You keep typing in the
same window; the agent's writes show up in that window as a dim `[agent → N B] …` line.

```
AI agent ── mcp__tabby__serial_* ──► http://127.0.0.1:3002/mcp
                                          │  (Tabby plugin: tabby-serial-mcp)
                                          ▼
                              Tabby SerialSession  ──►  your serial device
                                          ▲
                                    you, typing here
```

## Why not just use a serial MCP server?

A plain serial MCP server has to `open()` the port, and serial ports are exclusive: once the agent owns
it, your Tabby tab cannot. This plugin inverts that — Tabby keeps the port, and the agent gets a
tap on the byte stream.

## Requirements

- Tabby 1.0.23x (tested on 1.0.238, Windows). The plugin uses the public `tabby-core` / `tabby-terminal`
  APIs and needs no build step.
- Node 18+ inside Tabby (bundled with Tabby).
- Optional: [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) for the ready-made
  `dsh-bundle/`, or any MCP client that speaks streamable HTTP.

## Install

### 1. Tabby plugin

```powershell
# Windows — installs the latest release and restarts Tabby
iwr -useb https://raw.githubusercontent.com/Wazy-XD/tabby-serial-mcp/main/scripts/install.ps1 | iex
```

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/Wazy-XD/tabby-serial-mcp/main/scripts/install.sh | bash
```

Manual install: download `tabby-serial-mcp.zip` from the [latest release](../../releases/latest),
extract it into your Tabby plugin directory so that the folder is named `tabby-serial-mcp`:

| OS | Path |
|---|---|
| Windows | `%APPDATA%\tabby\plugins\node_modules\` |
| macOS | `~/Library/Application Support/tabby/plugins/node_modules/` |
| Linux | `~/.config/tabby/plugins/node_modules/` |

Then restart Tabby. `http://127.0.0.1:3002/health` should answer `running: true`, and Tabby's settings
grow a **Serial MCP** page (status, port, echo toggle, restart).

The plugin is also on npm as [`tabby-serial-mcp`](https://www.npmjs.com/package/tabby-serial-mcp), so
Tabby can install it itself: **Settings → Plugins → search `serial mcp` → Install**, then restart.

### 2. MCP client

Point any streamable-HTTP MCP client at `http://127.0.0.1:3002/mcp`.

For DeepSeek Harness, `dsh-bundle/` is a configuration-only bundle that wires the official
`@deepseek-ai/dsh-mcp-client` to that URL. It is published as
[`dsh-tabby-serial`](https://www.npmjs.com/package/dsh-tabby-serial):

```
plugin_manager install_bundle dsh-tabby-serial
```

Installing straight from this repository works too (`github:Wazy-XD/tabby-serial-mcp#path:/dsh-bundle`);
either way the profile lockfile pins an exact version/commit. To upgrade later, `remove_bundle
dsh-tabby-serial` and install again. A release tarball (`dsh-tabby-serial.zip`) works as well; or add the
row by hand:

```yaml
- insert:
    - id: tabby-serial-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: tabby
        transport: streamable-http
        url: http://127.0.0.1:3002/mcp
        toolCallTimeoutMs: 60000
        failOnStartupError: false
        reconnect:
          enabled: true
          initialDelayMs: 1000
          maxDelayMs: 30000
          maxAttempts: 200
```

Tools then appear as `mcp__tabby__serial_*`.

## Tools

| Tool | What it does |
|---|---|
| `serial_list_ports` | List serial ports (path, manufacturer, serial number, vid:pid) |
| `serial_list_tabs` | List open serial tabs; the `id` is the `target` for everything else |
| `serial_open` | Open a new serial tab (port, baud rate, data/stop bits, parity, title) |
| `serial_close` | Close a tab and release the port |
| `serial_status` | Port, line settings, byte counters, buffer offsets for one tab |
| `serial_write` | Write raw bytes: `data` (with `\r\n\xNN` escapes) or `hex` |
| `serial_read` | Read received bytes; `timeoutMs` long-polls, `as: auto/text/hex` |
| `serial_expect` | Wait for a regex; with `write`/`hex` it arms the matcher *before* sending, so a fast reply is not missed |
| `serial_annotate` | Print a display-only line in the tab (never sent to the device) |

`target` accepts a tab id (`s1`), a port name (`COM13`), or is omitted to use the focused serial tab
when exactly one is open.

## Usage

```
serial_list_ports
serial_open   { "port": "COM13", "baudRate": 115200 }
serial_write  { "data": "AT+CSQ\r\n" }
serial_read   { "timeoutMs": 1000 }
```

Or in one call, the useful one for request/response devices:

```
serial_expect { "pattern": "\\+CSQ: *\\d+,\\d+", "timeoutMs": 3000, "write": "AT+CSQ\r\n" }
```

Reads are cursor-based. `serial_read` returns `from`/`to` absolute stream offsets; pass `from` to
re-read a region idempotently, and `bufferStart` tells you the earliest offset still buffered.

## Configuration

`%APPDATA%\tabby\serial-mcp.json` (the settings page writes it for you):

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Start the MCP server on boot |
| `host` | `127.0.0.1` | Bind address (loopback only, by design) |
| `port` | `3002` | MCP port |
| `echoAgentWrites` | `true` | Print the dim `[agent → N B]` line in the tab |
| `ringBufferBytes` | `4194304` | Per-tab receive buffer |
| `maxReadBytes` | `1048576` | Upper bound for a single `serial_read` |

Log: `%APPDATA%\tabby\serial-mcp.log` (rotated at 2 MB). Tabby's renderer console is invisible, so this
file is the first place to look when the plugin fails to load.

## Troubleshooting

```powershell
Invoke-RestMethod http://127.0.0.1:3002/health          # is the bridge up?
Get-Content "$env:APPDATA\tabby\serial-mcp.log" -Tail 40 # what did it do?
Get-NetTCPConnection -LocalPort 3002                    # who owns the port?
```

Open <http://127.0.0.1:3002/> in a browser for a small status page.

## Limitations

- **Only bytes received after the plugin attached are buffered.** Data that scrolled past in a tab
  before Tabby loaded the plugin is not in the ring buffer (`bufferStart` reports the earliest offset).
- **A tab that was never displayed has no session yet.** Tabs restored by Tabby but never clicked show
  `rendered: false`; open them once. Tabs created by `serial_open` are activated immediately.
- **One COM port per tab.** `serial_open` on a busy port fails with an explanation.
- **Loopback, no authentication.** Same trust model as Tabby itself; do not expose it to a network.
- Windows is the tested platform. The macOS/Linux paths in `install.sh` follow Tabby's userData
  conventions but are untested.
- The server implements the 2025-era MCP handshake (it answers the 2026-07-28 `server/discover` probe
  with `-32601` so clients fall back). Verified against `@modelcontextprotocol/client` 2.2.0.

## Development

```
tabby-plugin/     the Tabby plugin (plain CommonJS, no build step)
  index.js        NgModule + APP_INITIALIZER
  lib/bridge.js   config, registry, MCP server lifecycle, tab open/close
  lib/sessions.js serial tab discovery, raw byte ring buffer, read/expect
  lib/ring.js     absolute-offset byte ring buffer
  lib/tools.js    the nine MCP tools
  lib/mcp-server.js  streamable-HTTP JSON-RPC server on node:http
  lib/settings-tab.js Tabby settings page (zh/en)
dsh-bundle/       DeepSeek Harness configuration-only bundle
test/             protocol regression test (real MCP SDK, fake Tabby registry)
```

After editing the plugin, copy `tabby-plugin/` over the installed folder
(`.../plugins/node_modules/tabby-serial-mcp`) and restart Tabby.

Protocol test:

```bash
cd test
npm install
node protocol-test.mjs
```

It spins up the real server with the real MCP SDK and exercises initialization, tool listing, text and
hex writes, read, expect (including the arm-before-write path), timeouts and error mapping.

## License

MIT — see [LICENSE](LICENSE).
