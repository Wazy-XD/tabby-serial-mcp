'use strict'

const NEWLINES = {
    none: '',
    lf: '\n',
    cr: '\r',
    crlf: '\r\n',
}

const TARGET_PROPERTY = {
    type: 'string',
    description: 'Which serial tab: a tab id from serial_list_tabs (e.g. "s1"), a port name such as "COM13", or omit it to use the focused serial tab when exactly one serial tab is open.',
}

function toHex (buf) {
    if (!buf || !buf.length) {
        return ''
    }
    return buf.toString('hex').replace(/../g, group => group + ' ').trim()
}

function fromHex (input) {
    const cleaned = String(input)
        .replace(/0x/gi, '')
        .replace(/[^0-9a-fA-F]/g, '')
    if (!cleaned.length) {
        throw new Error('hex payload is empty')
    }
    if (cleaned.length % 2) {
        throw new Error('hex payload has an odd number of digits')
    }
    return Buffer.from(cleaned, 'hex')
}

function unescapeText (input) {
    const source = String(input)
    let out = ''
    for (let i = 0; i < source.length; i++) {
        const ch = source[i]
        if (ch !== '\\') {
            out += ch
            continue
        }
        const next = source[i + 1]
        if (next === undefined) {
            out += '\\'
            continue
        }
        if (next === 'r') {
            out += '\r'
            i++
        } else if (next === 'n') {
            out += '\n'
            i++
        } else if (next === 't') {
            out += '\t'
            i++
        } else if (next === '0') {
            out += '\0'
            i++
        } else if (next === '\\') {
            out += '\\'
            i++
        } else if (next === 'x' && /^[0-9a-fA-F]{2}$/.test(source.slice(i + 2, i + 4))) {
            out += String.fromCharCode(parseInt(source.slice(i + 2, i + 4), 16))
            i += 3
        } else if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(source.slice(i + 2, i + 6))) {
            out += String.fromCharCode(parseInt(source.slice(i + 2, i + 6), 16))
            i += 5
        } else {
            out += '\\'
        }
    }
    return out
}

function looksTextual (buf) {
    if (!buf.length) {
        return true
    }
    let printable = 0
    for (const byte of buf) {
        if (byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x1b || (byte >= 0x20 && byte < 0x7f) || byte >= 0x80) {
            printable++
        }
    }
    return printable / buf.length >= 0.9
}

function asciiPreview (buf, maxLength = 512) {
    let out = ''
    for (const byte of buf.subarray(0, maxLength)) {
        out += byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.'
    }
    return out
}

function describeBytes (buf, mode) {
    if (!buf || !buf.length) {
        return { bytes: 0 }
    }
    const as = mode === 'hex' || mode === 'text' ? mode : (looksTextual(buf) ? 'text' : 'hex')
    if (as === 'text') {
        return { bytes: buf.length, text: buf.toString('utf8') }
    }
    return { bytes: buf.length, hex: toHex(buf), ascii: asciiPreview(buf) }
}

function clampInt (value, fallback, min, max) {
    const number = Math.trunc(Number(value))
    if (!Number.isFinite(number)) {
        return fallback
    }
    return Math.max(min, Math.min(max, number))
}

function buildWriteBytes (args) {
    let bytes
    if (args.hex !== undefined && args.hex !== null && String(args.hex).trim() !== '') {
        bytes = fromHex(args.hex)
    } else if (args.data !== undefined && args.data !== null) {
        const encoding = args.encoding === 'latin1' ? 'latin1' : 'utf8'
        bytes = Buffer.from(unescapeText(args.data), encoding)
    } else {
        throw new Error('pass either "data" (text) or "hex" (raw bytes)')
    }
    const suffix = NEWLINES[args.newline || 'none'] ?? ''
    if (suffix) {
        bytes = Buffer.concat([bytes, Buffer.from(suffix, 'ascii')])
    }
    return bytes
}

function createTools (bridge) {
    const registry = () => bridge.registry

    return [
        {
            name: 'serial_list_ports',
            title: 'List serial ports',
            description: 'List the serial ports present on this machine (COM12, COM13, ... on Windows). Use this before serial_open.',
            inputSchema: { type: 'object', properties: {} },
            handler: async () => ({ ports: await bridge.listPorts() }),
        },
        {
            name: 'serial_list_tabs',
            title: 'List open serial tabs',
            description: 'List the serial connections currently open as tabs in Tabby. Every entry has an "id" usable as the "target" argument of the other serial tools. Also reports how many received bytes are still unread and the absolute stream offsets (bufferStart/bufferEnd) that "from" refers to.',
            inputSchema: { type: 'object', properties: {} },
            handler: async () => {
                const active = bridge.app && bridge.app.activeTab
                const targets = registry().sync()
                return {
                    tabs: targets.map(target => target.info(active, registry().findTop(target.tab))),
                    count: targets.length,
                }
            },
        },
        {
            name: 'serial_open',
            title: 'Open a serial tab',
            description: 'Open a new serial connection as a tab in Tabby (the user sees it in the window and can type into it). Returns the new tab id. Fails if the port is already held open by another program or tab.',
            inputSchema: {
                type: 'object',
                properties: {
                    port: { type: 'string', description: 'Port name, e.g. "COM13". See serial_list_ports.' },
                    baudRate: { type: 'number', description: 'Baud rate, default 115200.' },
                    dataBits: { type: 'number', enum: [5, 6, 7, 8], description: 'Default 8.' },
                    stopBits: { type: 'number', enum: [1, 1.5, 2], description: 'Default 1.' },
                    parity: { type: 'string', enum: ['none', 'even', 'odd', 'mark', 'space'], description: 'Default "none".' },
                    title: { type: 'string', description: 'Tab title, default "PORT @baud".' },
                },
                required: ['port'],
            },
            handler: async args => bridge.openSerial({
                port: String(args.port || '').trim(),
                baudRate: clampInt(args.baudRate, 115200, 1, 20000000),
                dataBits: [5, 6, 7, 8].includes(Number(args.dataBits)) ? Number(args.dataBits) : 8,
                stopBits: [1, 1.5, 2].includes(Number(args.stopBits)) ? Number(args.stopBits) : 1,
                parity: ['none', 'even', 'odd', 'mark', 'space'].includes(args.parity) ? args.parity : 'none',
                title: args.title ? String(args.title) : null,
            }),
        },
        {
            name: 'serial_close',
            title: 'Close a serial tab',
            description: 'Close a serial tab opened by serial_open or by the user. The port is released.',
            inputSchema: {
                type: 'object',
                properties: { target: TARGET_PROPERTY },
            },
            handler: async args => {
                const target = registry().resolve(args.target)
                const id = target.id
                const port = target.port
                await bridge.closeTarget(target)
                return { closed: true, id, port }
            },
        },
        {
            name: 'serial_status',
            title: 'Serial tab status',
            description: 'Detailed state of one serial tab: port, line settings, open state, byte counters and buffer offsets.',
            inputSchema: {
                type: 'object',
                properties: { target: TARGET_PROPERTY },
            },
            handler: async args => {
                const target = registry().resolve(args.target)
                return target.info(bridge.app && bridge.app.activeTab, registry().findTop(target.tab))
            },
        },
        {
            name: 'serial_write',
            title: 'Write raw bytes to a serial port',
            description: 'Send raw bytes straight to the serial port of an open tab, bypassing Tabby input processing. Nothing is added unless "newline" asks for it. The write is echoed into the terminal as a dim "[agent → N B]" line so the user can see what was sent.',
            inputSchema: {
                type: 'object',
                properties: {
                    target: TARGET_PROPERTY,
                    data: { type: 'string', description: 'Text to send; supports \\r \\n \\t \\xNN escapes. Omit when using "hex".' },
                    hex: { type: 'string', description: 'Bytes to send as hex, e.g. "41 54 0D 0A". Omit when using "data".' },
                    newline: { type: 'string', enum: ['none', 'lf', 'cr', 'crlf'], description: 'Line ending appended after the payload. Default "none".' },
                    encoding: { type: 'string', enum: ['utf8', 'latin1'], description: 'Text encoding for "data". Default "utf8".' },
                },
            },
            handler: async args => {
                const target = registry().resolve(args.target)
                const bytes = buildWriteBytes(args)
                target.write(bytes)
                target.echoWrite(bytes)
                return { target: target.id, port: target.port, written: bytes.length, hex: toHex(bytes) }
            },
        },
        {
            name: 'serial_read',
            title: 'Read received bytes',
            description: 'Return bytes received on a serial tab since the last read (or since an explicit absolute offset). Returns "text" for printable data and "hex" plus an ASCII preview for binary data; pass as:"hex" to always get hex. With timeoutMs > 0 it waits for the next bytes instead of returning empty.',
            inputSchema: {
                type: 'object',
                properties: {
                    target: TARGET_PROPERTY,
                    maxBytes: { type: 'number', description: 'Maximum bytes returned. Default 4096, capped at 1048576.' },
                    timeoutMs: { type: 'number', description: 'If nothing is buffered yet, wait up to this many ms for data. Default 0 (return immediately).' },
                    as: { type: 'string', enum: ['auto', 'text', 'hex'], description: 'Output format. Default "auto".' },
                    from: { type: 'number', description: 'Absolute stream offset to read from (see bufferStart/bufferEnd). Default: continue after the previous read.' },
                },
            },
            handler: async args => {
                const target = registry().resolve(args.target)
                const maxBytes = clampInt(args.maxBytes, 4096, 1, bridge.config.get('maxReadBytes') || 1048576)
                const timeoutMs = clampInt(args.timeoutMs, 0, 0, 600000)
                const result = await target.read({
                    from: Number.isFinite(args.from) ? Number(args.from) : undefined,
                    maxBytes,
                    timeoutMs,
                })
                return {
                    target: target.id,
                    port: target.port,
                    from: result.from,
                    to: result.to,
                    timedOut: result.timedOut,
                    dropped: result.dropped,
                    ...describeBytes(result.data, args.as),
                }
            },
        },
        {
            name: 'serial_expect',
            title: 'Wait for a serial response',
            description: 'Wait until text received on a serial tab matches a JavaScript regular expression, then return the match and its surrounding context. Pass "write" or "hex" to send a request and wait for its reply in one call (the matcher is armed before the bytes go out, so a fast reply is not missed). Matching consumes the bytes; anything not matching before the timeout is returned in "text".',
            inputSchema: {
                type: 'object',
                properties: {
                    target: TARGET_PROPERTY,
                    pattern: { type: 'string', description: 'Regular expression, e.g. "\\bOK\\b", "^READY", "\\+CSQ: *\\d+".' },
                    flags: { type: 'string', description: 'Regex flags, e.g. "m" or "i". Default "".' },
                    timeoutMs: { type: 'number', description: 'Give up after this many ms. Default 5000.' },
                    from: { type: 'number', description: 'Absolute stream offset to start scanning from. Default: the unread position, so bytes that arrived before this call are still considered.' },
                    write: { type: 'string', description: 'Text to send right after arming the matcher; supports \\r \\n escaped sequences.' },
                    hex: { type: 'string', description: 'Raw bytes to send instead of "write".' },
                    newline: { type: 'string', enum: ['none', 'lf', 'cr', 'crlf'], description: 'Line ending appended to the outgoing payload.' },
                },
                required: ['pattern'],
            },
            handler: async args => {
                const target = registry().resolve(args.target)
                const timeoutMs = clampInt(args.timeoutMs, 5000, 0, 600000)
                const pending = target.expect({
                    pattern: String(args.pattern),
                    flags: args.flags ? String(args.flags) : '',
                    from: Number.isFinite(args.from) ? Number(args.from) : undefined,
                    timeoutMs,
                })

                let sent = null
                if ((args.write !== undefined && args.write !== null) || (args.hex !== undefined && args.hex !== null)) {
                    try {
                        const bytes = buildWriteBytes({
                            data: args.write,
                            hex: args.hex,
                            newline: args.newline,
                        })
                        target.write(bytes)
                        target.echoWrite(bytes)
                        sent = { written: bytes.length, hex: toHex(bytes) }
                    } catch (error) {
                        return { target: target.id, port: target.port, sent: null, writeError: error.message, matched: false, timedOut: true }
                    }
                }

                const result = await pending
                return { target: target.id, port: target.port, sent, ...result }
            },
        },
        {
            name: 'serial_annotate',
            title: 'Print a note in the serial tab',
            description: 'Print a line into the serial tab for the human watching it. Display only: the bytes never reach the device. Use it to explain what the agent is about to do.',
            inputSchema: {
                type: 'object',
                properties: {
                    target: TARGET_PROPERTY,
                    text: { type: 'string', description: 'Note text.' },
                },
                required: ['text'],
            },
            handler: async args => {
                const target = registry().resolve(args.target)
                const ok = target.annotate(`[agent] ${String(args.text)}`)
                return { target: target.id, shown: ok }
            },
        },
    ]
}

module.exports = {
    createTools,
    toHex,
    fromHex,
    unescapeText,
    looksTextual,
    describeBytes,
}
