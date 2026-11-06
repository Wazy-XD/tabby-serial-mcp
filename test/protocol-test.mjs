// Exercises the real plugin code (lib/mcp-server.js + lib/tools.js) with the real
// MCP SDK the DSH host ships, using a fake Tabby registry.
import { createRequire } from 'node:module'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

const require = createRequire(import.meta.url)
const { createMcpServer } = require('../tabby-plugin/lib/mcp-server.js')
const { createTools } = require('../tabby-plugin/lib/tools.js')
const { RingBuffer } = require('../tabby-plugin/lib/ring.js')

const PORT = Number(process.env.PORT ?? 4010)

class FakeTarget {
    constructor (id, port, baudRate) {
        this.id = id
        this.port = port
        this.baudRate = baudRate
        this.tab = { title: `${port} @${baudRate}`, destroyed: false }
        this.ring = new RingBuffer(1024 * 1024)
        this.readCursor = 0
        this.writes = []
        this.rx = 0
    }

    info () {
        return {
            id: this.id, port: this.port, baudRate: this.baudRate,
            title: this.tab.title, open: true, active: false,
            rxBytes: this.rx, txBytes: this.writes.reduce((a, b) => a + b.length, 0),
            bufferedBytes: this.ring.length, bufferStart: this.ring.base,
            bufferEnd: this.ring.end, unreadBytes: this.ring.end - this.readCursor,
        }
    }

    push (buf) { this.ring.push(buf); this.rx += buf.length; this.notify() }

    notify () { for (const w of [...this.waiters]) w.check() }

    waitFor (predicate, timeoutMs) {
        return new Promise(resolve => {
            const w = { done: false }
            w.settle = v => { if (w.done) return; w.done = true; clearTimeout(w.timer); this.waiters.delete(w); resolve(v) }
            w.check = () => { if (w.done) return; const v = predicate(); if (v) w.settle(v) }
            w.timer = setTimeout(() => w.settle(null), Math.max(0, timeoutMs || 0))
            this.waiters.add(w)
            w.check()
        })
    }

    async read ({ from, maxBytes, timeoutMs }) {
        const start = Number.isFinite(from) ? from : this.readCursor
        const first = this.ring.slice(start, maxBytes)
        if (first.to > first.from) { this.readCursor = first.to; return { ...first, timedOut: false } }
        if (!(timeoutMs > 0)) return { data: Buffer.alloc(0), from: first.from, to: first.to, dropped: first.dropped, timedOut: false }
        const got = await this.waitFor(() => { const s = this.ring.slice(start, maxBytes); return s.to > s.from ? s : null }, timeoutMs)
        if (got) { this.readCursor = got.to; return { ...got, timedOut: false } }
        const last = this.ring.slice(start, maxBytes)
        return { data: Buffer.alloc(0), from: last.from, to: last.to, dropped: last.dropped, timedOut: true }
    }

    expect ({ pattern, flags, from, timeoutMs }) {
        const re = new RegExp(pattern, flags || '')
        const requested = Number.isFinite(from) ? from : this.readCursor
        let cursor = Math.max(this.ring.base, Math.min(requested, this.ring.end))
        let text = ''
        const pump = () => {
            const s = this.ring.slice(cursor, 1 << 20)
            if (s.to > s.from) { cursor = s.to; text += s.data.toString('utf8') }
        }
        const match = () => {
            pump()
            re.lastIndex = 0
            const m = re.exec(text)
            if (!m) return null
            return { matched: true, timedOut: false, match: m[0], groups: m.slice(1), index: m.index, context: text, text }
        }
        pump()
        return this.waitFor(match, timeoutMs).then(r => {
            this.readCursor = this.ring.end
            return r ?? { matched: false, timedOut: true, text }
        })
    }

    write (bytes) {
        this.writes.push(bytes)
        this.lastWrite = bytes
        const text = bytes.toString('latin1')
        if (text.includes('AT+CSQ')) {
            setTimeout(() => this.push(Buffer.from('\r\n+CSQ: 22,99\r\n\r\nOK\r\n')), 60)
        }
    }
    echoWrite () {}
    annotate () { return true }
}

const target = new FakeTarget('s1', 'COM13', 115200)
target.waiters = new Set()

const bridge = {
    app: { activeTab: null },
    config: { get: () => 4096 },
    listPorts: async () => [{ path: 'COM13', label: 'COM13' }],
    openSerial: async () => ({ id: 's2', port: 'COM13', baudRate: 115200, open: true }),
    closeTarget: async () => {},
    registry: {
        sync: () => [target],
        resolve: (query) => {
            if (query === undefined || query === 's1' || query === 'COM13') return target
            throw new Error('Unknown serial target "' + query + '"')
        },
        findTop: () => null,
    },
}

const server = createMcpServer({
    tools: createTools(bridge),
    instructions: 'test instructions',
    version: '1.0.0',
    log: m => console.log('[srv]', m),
})
await server.start('127.0.0.1', PORT)
console.log('[probe] server up', server.health().url)

const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`))
const client = new Client(
    { name: 'dsh-mcp-client', version: '0.0.1' },
    { capabilities: {}, versionNegotiation: { mode: 'auto' }, listChanged: { tools: { autoRefresh: false, debounceMs: 0 } } },
)

const fail = []
function check (name, condition, detail) {
    if (condition) console.log(`[ok]   ${name}`)
    else { console.log(`[FAIL] ${name}`, detail ?? ''); fail.push(name) }
}

try {
    await client.connect(transport)
    console.log('[probe] protocolVersion =', transport.protocolVersion)
    console.log('[probe] capabilities =', JSON.stringify(client.getServerCapabilities()))
    console.log('[probe] instructions =', JSON.stringify(client.getInstructions()))

    const list = await client.listTools(undefined, { cacheMode: 'refresh' })
    console.log('[probe] tools =', list.tools.map(t => t.name).join(', '))
    check('9 tools listed', list.tools.length === 9, list.tools.length)

    const call = async (name, args) => {
        const r = await client.callTool({ name, arguments: args })
        const text = (r.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n')
        return { isError: r.isError, text, json: (() => { try { return JSON.parse(text) } catch { return null } })() }
    }

    let r = await call('serial_list_ports', {})
    check('list_ports', r.json?.ports?.[0]?.path === 'COM13', r.text)

    r = await call('serial_list_tabs', {})
    check('list_tabs', r.json?.tabs?.[0]?.id === 's1', r.text)

    r = await call('serial_write', { target: 's1', data: 'AT+CSQ\\r\\n' })
    check('write text+escapes', target.lastWrite?.toString('hex') === '41542b4353510d0a', r.text)

    r = await call('serial_write', { hex: '41 54 0D' })
    check('write hex', target.lastWrite?.toString('hex') === '41540d', r.text)

    target.push(Buffer.from('+CSQ: 22,99\r\nOK\r\n'))
    r = await call('serial_read', { target: 's1' })
    check('read text', r.json?.text?.includes('+CSQ: 22,99'), r.text)

    r = await call('serial_expect', { target: 's1', pattern: '\\+CSQ: (\\d+)', timeoutMs: 800, write: 'AT+CSQ\\r\\n' })
    check('expect matched', r.json?.matched === true && r.json?.groups?.[0] === '22', r.text)
    check('expect armed before write', target.lastWrite?.toString('hex') === '41542b4353510d0a')

    r = await call('serial_expect', { target: 's1', pattern: 'NEVER', timeoutMs: 150 })
    check('expect timeout', r.json?.matched === false && r.json?.timedOut === true, r.text)

    setTimeout(() => target.push(Buffer.from('LATE')), 300)
    r = await call('serial_read', { target: 's1', timeoutMs: 1500 })
    check('read long-poll', r.json?.text === 'LATE', r.text)

    r = await call('serial_open', { port: 'COM13', baudRate: 9600 })
    check('open', r.json?.id === 's2', r.text)

    r = await call('serial_status', { target: 's1' })
    check('status', r.json?.port === 'COM13', r.text)

    r = await call('serial_annotate', { target: 's1', text: 'hello' })
    check('annotate', r.json?.shown === true, r.text)

    r = await call('serial_write', { target: 'nope', data: 'x' })
    check('unknown target -> isError', r.isError === true && /Unknown serial target/.test(r.text), r.text)

    r = await call('serial_write', {})
    check('missing payload -> isError', r.isError === true && /data/.test(r.text), r.text)
} catch (error) {
    console.log('[probe] ERROR', error?.constructor?.name, error?.message)
    console.log(error?.stack)
    fail.push('exception')
} finally {
    try { await client.close() } catch {}
    await server.stop()
}

console.log(fail.length ? `\n[probe] FAILED: ${fail.join(', ')}` : '\n[probe] all checks passed')
process.exitCode = fail.length ? 1 : 0

