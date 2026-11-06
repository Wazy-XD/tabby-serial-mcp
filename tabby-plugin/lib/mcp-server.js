'use strict'

const http = require('http')

const MAX_BODY_BYTES = 8 * 1024 * 1024
const MAX_RESULT_TEXT = 512 * 1024
const LEGACY_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'])
const PREFERRED_VERSION = '2025-11-25'

function truncate (text) {
    if (typeof text !== 'string' || text.length <= MAX_RESULT_TEXT) {
        return text
    }
    return `${text.slice(0, MAX_RESULT_TEXT)}\n... [truncated ${text.length - MAX_RESULT_TEXT} characters]`
}

function createMcpServer (options = {}) {
    const tools = Array.isArray(options.tools) ? options.tools : []
    const toolMap = new Map(tools.map(tool => [tool.name, tool]))
    const serverInfo = {
        name: options.name || 'tabby-serial-mcp',
        version: options.version || '1.0.0',
    }
    const instructions = options.instructions || ''
    const log = options.log || (() => {})

    const state = {
        server: null,
        sockets: new Set(),
        host: null,
        port: null,
        startedAt: null,
        requests: 0,
        errors: 0,
        lastError: null,
    }

    function rpcResult (id, value) {
        return { jsonrpc: '2.0', id, result: value }
    }

    function rpcFailure (id, code, message) {
        return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } }
    }

    async function dispatch (message) {
        if (!message || typeof message !== 'object' || Array.isArray(message)) {
            return rpcFailure(null, -32600, 'Invalid Request')
        }
        const { id, method } = message
        if (method === undefined) {
            return null
        }
        if (id === undefined) {
            // notifications/initialized, notifications/cancelled, ...
            return null
        }

        // This server implements the 2025-era JSON-RPC subset only. Answering the
        // 2026-07-28 discovery probe with "method not found" makes SDK clients fall
        // back to the classic initialize handshake.
        if (method === 'server/discover') {
            return rpcFailure(id, -32601, 'Method not found: server/discover')
        }

        switch (method) {
            case 'initialize': {
                const requested = message.params && message.params.protocolVersion
                return rpcResult(id, {
                    protocolVersion: LEGACY_VERSIONS.has(requested) ? requested : PREFERRED_VERSION,
                    capabilities: { tools: { listChanged: false } },
                    serverInfo,
                    instructions,
                })
            }
            case 'ping':
                return rpcResult(id, {})
            case 'tools/list':
                return rpcResult(id, {
                    tools: tools.map(tool => ({
                        name: tool.name,
                        title: tool.title,
                        description: tool.description,
                        inputSchema: tool.inputSchema,
                    })),
                })
            case 'tools/call': {
                const params = message.params || {}
                const tool = toolMap.get(params.name)
                if (!tool) {
                    return rpcFailure(id, -32602, `Unknown tool: ${params.name}`)
                }
                let args = params.arguments
                if (args === undefined || args === null) {
                    args = {}
                }
                if (typeof args !== 'object' || Array.isArray(args)) {
                    return rpcFailure(id, -32602, 'Tool arguments must be an object')
                }
                try {
                    const value = await tool.handler(args)
                    const text = truncate(JSON.stringify(value === undefined ? null : value, null, 2))
                    return rpcResult(id, { content: [{ type: 'text', text }], isError: false })
                } catch (error) {
                    state.errors++
                    const message2 = error && error.message ? error.message : String(error)
                    return rpcResult(id, { content: [{ type: 'text', text: `Error: ${message2}` }], isError: true })
                }
            }
            case 'resources/list':
                return rpcResult(id, { resources: [] })
            case 'prompts/list':
                return rpcResult(id, { prompts: [] })
            default:
                return rpcFailure(id, -32601, `Method not found: ${method}`)
        }
    }

    function sendJson (res, status, payload) {
        const body = Buffer.from(JSON.stringify(payload), 'utf8')
        res.writeHead(status, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': body.length,
            'cache-control': 'no-store',
        })
        res.end(body)
    }

    function sendText (res, status, text, contentType = 'text/plain; charset=utf-8') {
        const body = Buffer.from(text, 'utf8')
        res.writeHead(status, {
            'content-type': contentType,
            'content-length': body.length,
            'cache-control': 'no-store',
        })
        res.end(body)
    }

    async function handlePost (req, res) {
        const chunks = []
        let size = 0
        let overflow = false

        req.on('data', chunk => {
            size += chunk.length
            if (size > MAX_BODY_BYTES) {
                overflow = true
                return
            }
            chunks.push(chunk)
        })

        req.on('end', async () => {
            if (overflow) {
                sendJson(res, 413, rpcFailure(null, -32600, 'Request body too large'))
                return
            }
            const body = Buffer.concat(chunks).toString('utf8')
            if (!body.trim()) {
                sendJson(res, 400, rpcFailure(null, -32700, 'Parse error: empty body'))
                return
            }

            let payload
            try {
                payload = JSON.parse(body)
            } catch (error) {
                sendJson(res, 400, rpcFailure(null, -32700, `Parse error: ${error.message}`))
                return
            }

            state.requests++
            const messages = Array.isArray(payload) ? payload : [payload]
            const responses = []
            for (const message of messages) {
                let response = null
                try {
                    response = await dispatch(message)
                } catch (error) {
                    state.errors++
                    response = rpcFailure(message && message.id, -32603, error.message)
                }
                if (response) {
                    responses.push(response)
                }
            }

            if (!responses.length) {
                res.writeHead(202, { 'cache-control': 'no-store' })
                res.end()
                return
            }
            sendJson(res, 200, Array.isArray(payload) ? responses : responses[0])
        })
    }

    function health () {
        let extra = {}
        try {
            extra = options.describe ? options.describe() : {}
        } catch { /* extra fields are best effort */ }
        return {
            running: !!state.server,
            url: state.host ? `http://${state.host}:${state.port}/mcp` : null,
            host: state.host,
            port: state.port,
            startedAt: state.startedAt,
            requests: state.requests,
            errors: state.errors,
            lastError: state.lastError,
            tools: tools.map(tool => tool.name),
            ...extra,
        }
    }

    const handler = (req, res) => {
        let pathname = '/'
        try {
            pathname = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`).pathname.replace(/\/+$/, '') || '/'
        } catch { /* keep '/' */ }

        if (pathname === '/health' || pathname === '/status') {
            sendJson(res, 200, health())
            return
        }

        if (pathname === '/' && req.method === 'GET') {
            const info = health()
            sendText(res, 200, `<!doctype html><meta charset="utf-8"><title>Tabby serial MCP</title>
<style>body{font:14px/1.5 ui-monospace,Consolas,monospace;margin:2rem;background:#171717;color:#cacaca}
code{color:#82fff7}h1{font-size:1.1rem}</style>
<h1>Tabby serial MCP bridge</h1>
<p>Endpoint: <code>${info.url || '(stopped)'}</code></p>
<p>Requests: ${info.requests} &middot; errors: ${info.errors}</p>
<p>Tools: ${info.tools.map(name => `<code>${name}</code>`).join(' ')}</p>
<p>${info.lastError ? `Last error: <code>${info.lastError}</code>` : 'No errors.'}</p>`, 'text/html; charset=utf-8')
            return
        }

        if (pathname !== '/mcp') {
            sendText(res, 404, 'Not found')
            return
        }

        if (req.method === 'POST') {
            handlePost(req, res).catch(error => {
                state.errors++
                state.lastError = error.message
                try {
                    sendJson(res, 500, rpcFailure(null, -32603, error.message))
                } catch { /* response already sent */ }
            })
            return
        }

        if (req.method === 'GET') {
            // No server-initiated messages: the transport contract allows a 405 here.
            res.writeHead(405, { allow: 'POST, DELETE', 'cache-control': 'no-store' })
            res.end()
            return
        }

        if (req.method === 'DELETE') {
            res.writeHead(200, { 'cache-control': 'no-store' })
            res.end()
            return
        }

        res.writeHead(405, { allow: 'POST, DELETE' })
        res.end()
    }

    return {
        name: serverInfo.name,
        tools,
        health,

        get running () {
            return !!state.server
        },

        async start (host, port) {
            if (state.server) {
                return health()
            }
            await new Promise((resolve, reject) => {
                const server = http.createServer(handler)
                const onError = error => {
                    server.removeListener('error', onError)
                    state.lastError = error.code === 'EADDRINUSE'
                        ? `port ${port} is already in use`
                        : error.message
                    reject(error)
                }
                server.once('error', onError)
                server.on('connection', socket => {
                    state.sockets.add(socket)
                    socket.on('close', () => state.sockets.delete(socket))
                })
                server.listen(port, host, () => {
                    server.removeListener('error', onError)
                    server.on('error', error => {
                        state.errors++
                        state.lastError = error.message
                        log(`server error: ${error.message}`)
                    })
                    state.server = server
                    state.host = host
                    state.port = server.address().port
                    state.startedAt = Date.now()
                    state.lastError = null
                    log(`listening on http://${host}:${state.port}/mcp`)
                    resolve()
                })
            })
            return health()
        },

        async stop () {
            const server = state.server
            if (!server) {
                return health()
            }
            state.server = null
            for (const socket of state.sockets) {
                try {
                    socket.destroy()
                } catch { /* ignore */ }
            }
            state.sockets.clear()
            await new Promise(resolve => {
                server.close(() => resolve())
                setTimeout(resolve, 1500)
            })
            state.host = null
            return health()
        },

        async restart (host, port) {
            await this.stop()
            return this.start(host, port)
        },
    }
}

module.exports = { createMcpServer }
