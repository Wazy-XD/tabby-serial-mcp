# Tabby serial MCP (DeepSeek Harness bundle)

Gives an agent read/write access to the serial tabs you already have open in Tabby, and lets it open
new ones.

This package is the Harness side only: it connects to the local MCP bridge that the Tabby plugin
exposes, and registers a `tabby-serial` skill so the agent knows where the serial entry point is.

> The serial I/O itself lives in the Tabby plugin
> [`tabby-serial-mcp`](https://www.npmjs.com/package/tabby-serial-mcp). This bundle connects and teaches.

## What it adds

| Row | Purpose |
|---|---|
| `tabby-serial-skill` | Registers the `tabby-serial` skill: entry points, the read/write loop, device quirks, and how to share a port with the human |
| `tabby-serial-mcp` | Connects the official `@deepseek-ai/dsh-mcp-client` to `http://127.0.0.1:3002/mcp` |

Tools appear as `mcp__tabby__serial_*`.

## Prerequisite

The `tabby-serial-mcp` plugin must be installed in Tabby and Tabby must be running:

```powershell
Invoke-RestMethod http://127.0.0.1:3002/health
```

`running: true` means ready. When Tabby is closed, this bundle simply reconnects; it never blocks DSH
startup (`failOnStartupError: false`, 200 reconnect attempts).

## Install

```text
plugin_manager install_bundle  target: dsh-tabby-serial
```

Pin a version with `dsh-tabby-serial@1.0.2`, or install from the repository
(`github:Wazy-XD/tabby-serial-mcp#path:/dsh-bundle`). Remove with
`plugin_manager remove_bundle target: dsh-tabby-serial`.

## Tools

| Tool | Purpose |
|---|---|
| `serial_list_ports` | List serial ports (manufacturer, serial number, vid:pid) |
| `serial_list_tabs` | List open Tabby serial tabs; the `id` is the `target` |
| `serial_open` | Open a serial tab (port, baud rate, data/stop bits, parity) |
| `serial_close` | Close a tab and release the port |
| `serial_status` | One tab's state, byte counters, buffer offsets |
| `serial_write` | Write raw bytes: `data` (with `\r\n\xNN` escapes) or `hex` |
| `serial_read` | Read bytes; `timeoutMs` long-polls, `as: hex/text/auto` |
| `serial_expect` | Wait for a regex; with `write` the matcher is armed before the bytes go out |
| `serial_annotate` | Print a display-only line in the tab |

## Configuration

Override the row in the profile's `cordis.patch.yml` to change the endpoint; `serverName` decides the
tool prefix (`mcp__<serverName>__serial_*`).

## Licence

MIT.
