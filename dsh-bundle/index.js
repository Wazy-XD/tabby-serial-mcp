const SKILL = String.raw`# Tabby serial console

Use this when the task involves a serial port — COM12, /dev/ttyUSB0, a UART header, AT commands, a
board's debug console — and the user runs Tabby, or wants a serial window opened there.

## Entry point

All serial I/O goes through the MCP tools named \`mcp__tabby__serial_*\` (MCP server "tabby",
\`http://127.0.0.1:3002/mcp\`). The port belongs to Tabby, not to you: never open the same COM port
with another tool, and never ask the user to close their window.

1. \`serial_list_tabs\` — is the port already open in Tabby? Take the \`id\` (\`s1\`, \`s2\`, ...).
2. \`serial_list_ports\` then \`serial_open { port, baudRate }\` — nothing open yet.
3. Omit \`target\` only when exactly one serial tab is open; otherwise pass the id or the port name.

## The loop

- Send: \`serial_write { target, data: "AT+CSQ\r\n" }\`, or \`{ hex: "41 54 0D 0A" }\` for binary.
- Ask and wait in one call: \`serial_expect { target, pattern: "OK|ERROR", timeoutMs: 3000, write: "AT\r\n" }\`.
  The matcher is armed *before* the bytes go out, so a fast reply cannot be missed.
- Stream: \`serial_read { target, timeoutMs: 1000, as: "hex" }\`. \`timeoutMs\` long-polls instead of
  returning empty.

## Rules that matter

- **Raw bytes.** Nothing is appended unless \`newline\` (\`lf\`/\`cr\`/\`crlf\`) or an explicit \`\r\n\` says so.
  Most devices want CRLF; a bare LF silently does nothing on many AT parsers.
- **Reads are cursor-based.** \`serial_read\` reports absolute \`from\`/\`to\` offsets. \`bufferStart\` is the
  earliest byte still buffered — anything received before the plugin attached is gone, so reset the
  device after the tool is up if you need its boot log.
- **\`rendered: false\` means the tab was never shown**, so its session does not exist yet. Ask the user to
  click it, or open your own tab with \`serial_open\`.
- **One port, one tab.** \`serial_open\` on a busy port fails; reuse the existing tab instead.
- **The user shares the port.** They may type at any moment, and their keystrokes reach the device
  immediately. Announce anything destructive (reset, flash, baud change, bootloader entry) with
  \`serial_annotate\` first, and prefer one deliberate command over a blind retry loop.
- **Close only what you opened.** \`serial_close\` on a tab the user opened interrupts their work.

## Device habits worth checking

- Text protocols: wait for the prompt (\`OK\`, \`>\`, \`#\`, \`\$ \`) before the next command instead of
  sleeping a fixed time.
- Binary protocols: work in hex (\`as: "hex"\`, \`hex\` writes) and compare bytes, not decoded text.
- No-echo devices: do not wait for your own command to come back; wait for the response only.
- Slow devices: raise \`timeoutMs\` rather than shortening the pattern; a partial line is not a match.
`

export const name = 'dsh-tabby-serial'

/**
 * Registers the `tabby-serial` skill when the skill registry is mounted. The MCP connection itself is a
 * separate row (see cordis.patch.yml), so this plugin stays optional and never blocks the connection.
 */
export function apply (ctx) {
    const skills = ctx.get('skills')
    if (!skills || typeof skills.register !== 'function') {
        return
    }
    ctx.effect(() => skills.register({
        name: 'tabby-serial',
        description: 'Drive a serial port through Tabby: list/open serial tabs, write raw bytes or hex, read with a cursor, and wait for a device reply with a regex.',
        whenToUse: 'A task mentions a serial port, COM port, UART, AT commands or a device console, and Tabby is available or the user wants a serial window opened.',
        source: 'runtime',
        content: SKILL,
        invocation: { modelInvocable: true, userInvocable: true },
    }))
}
