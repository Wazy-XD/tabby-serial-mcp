'use strict'

const { StringDecoder } = require('string_decoder')
const { RingBuffer } = require('./ring')

/** Upper bound for the text kept while waiting for a regex match. */
const MAX_EXPECT_ACCUMULATION = 256 * 1024
/** How much of the accumulated text is echoed back to the model. */
const MAX_EXPECT_TEXT = 8 * 1024

let sequence = 0

/**
 * `BaseTabComponent.destroyed` is a private Subject (always truthy), so liveness
 * has to come from the Angular view: TabsService destroys the ComponentRef when
 * the tab's destroyed$ fires.
 */
function isDestroyedTab (tab) {
    try {
        return !!(tab && tab.hostView && tab.hostView.destroyed)
    } catch {
        return false
    }
}

function isSerialTab (tab) {
    if (!tab || isDestroyedTab(tab)) {
        return false
    }
    const session = tab.session
    if (session) {
        if (typeof session.write !== 'function') {
            return false
        }
        const type = (tab.profile && tab.profile.type) || (session.profile && session.profile.type)
        if (type === 'serial') {
            return true
        }
        return 'serial' in session || 'serialService' in session
    }
    // The tab exists but its body has not been rendered yet, so `initializeSession`
    // has not run and `session` is still null. Trust the profile.
    return !!(tab.profile && tab.profile.type === 'serial')
}

/** Render bytes as something safe to print into the terminal (no control chars). */
function visible (buf, maxLength = 160) {
    let out = ''
    for (const byte of buf) {
        if (byte === 0x0d) {
            out += '\\r'
        } else if (byte === 0x0a) {
            out += '\\n'
        } else if (byte === 0x09) {
            out += '\\t'
        } else if (byte === 0x1b) {
            out += '\\e'
        } else if (byte >= 0x20 && byte < 0x7f) {
            out += String.fromCharCode(byte)
        } else {
            out += '\\x' + byte.toString(16).padStart(2, '0')
        }
        if (out.length >= maxLength) {
            return out + '\u2026'
        }
    }
    return out
}

class SerialTarget {
    constructor (registry, tab) {
        this.registry = registry
        this.tab = tab
        this.id = `s${++sequence}`
        this.createdAt = Date.now()
        this.ring = new RingBuffer(registry.config.get('ringBufferBytes'))
        this.readCursor = 0
        this.waiters = new Set()
        this.subscription = null
        this.rxBytes = 0
        this.txBytes = 0
        this.attach()
    }

    get config () {
        return this.registry.config
    }

    get session () {
        return this.tab ? this.tab.session : null
    }

    get profile () {
        const session = this.session
        return (session && session.profile) || (this.tab && this.tab.profile) || null
    }

    get options () {
        return (this.profile && this.profile.options) || {}
    }

    get port () {
        return this.options.port || null
    }

    get baudRate () {
        return this.options.baudrate ?? null
    }

    get title () {
        const tab = this.tab
        return (tab && (tab.customTitle || tab.title)) || this.port || this.id
    }

    get isOpen () {
        const session = this.session
        return !!(session && session.open)
    }

    get isAlive () {
        return !!(this.tab && !isDestroyedTab(this.tab) && this.session)
    }

    attach () {
        if (this.subscription) {
            return
        }
        const session = this.session
        if (!session || typeof session.binaryOutput$?.subscribe !== 'function') {
            return
        }
        try {
            this.subscription = session.binaryOutput$.subscribe(buf => {
                this.ring.push(buf)
                this.rxBytes += buf.length
                this.notify()
            })
        } catch (error) {
            this.registry.log(`cannot attach ${this.id}: ${error.message}`)
        }
    }

    detach () {
        if (this.subscription) {
            try {
                this.subscription.unsubscribe()
            } catch { /* ignore */ }
            this.subscription = null
        }
        for (const waiter of [...this.waiters]) {
            waiter.settle(null)
        }
        this.waiters.clear()
    }

    notify () {
        for (const waiter of [...this.waiters]) {
            waiter.check()
        }
    }

    waitFor (predicate, timeoutMs) {
        return new Promise(resolve => {
            const waiter = { done: false }
            waiter.settle = value => {
                if (waiter.done) {
                    return
                }
                waiter.done = true
                clearTimeout(waiter.timer)
                this.waiters.delete(waiter)
                resolve(value)
            }
            waiter.check = () => {
                if (waiter.done) {
                    return
                }
                let value = null
                try {
                    value = predicate()
                } catch (error) {
                    value = null
                }
                if (value) {
                    waiter.settle(value)
                }
            }
            waiter.timer = setTimeout(() => waiter.settle(null), Math.max(0, Number(timeoutMs) || 0))
            this.waiters.add(waiter)
            waiter.check()
        })
    }

    ensureOpen () {
        const session = this.session
        if (!session) {
            throw new Error(`serial tab ${this.id} has no session any more`)
        }
        if (!session.open) {
            throw new Error(`serial port ${this.port || '?'} of tab ${this.id} is not open`)
        }
        return session
    }

    write (bytes) {
        const session = this.ensureOpen()
        session.write(bytes)
        this.txBytes += bytes.length
    }

    annotate (text) {
        const tab = this.tab
        if (!tab || typeof tab.write !== 'function') {
            return false
        }
        try {
            tab.write(`\r\n\x1b[90m${String(text).replace(/\r?\n/g, ' ')}\x1b[0m\r\n`)
            return true
        } catch {
            return false
        }
    }

    echoWrite (bytes) {
        if (!this.config.get('echoAgentWrites')) {
            return
        }
        const tab = this.tab
        if (!tab || typeof tab.write !== 'function') {
            return
        }
        try {
            tab.write(`\r\n\x1b[90m[agent \u2192 ${bytes.length} B]\x1b[0m \x1b[36m${visible(bytes)}\x1b[0m\r\n`)
        } catch { /* the tab may be closing */ }
    }

    async read ({ from, maxBytes, timeoutMs } = {}) {
        const start = Number.isFinite(from) ? from : this.readCursor
        const first = this.ring.slice(start, maxBytes)
        if (first.to > first.from) {
            this.readCursor = first.to
            return { ...first, timedOut: false }
        }
        if (!(Number(timeoutMs) > 0)) {
            return { data: Buffer.alloc(0), from: first.from, to: first.to, dropped: first.dropped, timedOut: false }
        }
        const arrived = await this.waitFor(() => {
            const slice = this.ring.slice(start, maxBytes)
            return slice.to > slice.from ? slice : null
        }, timeoutMs)
        if (arrived) {
            this.readCursor = arrived.to
            return { ...arrived, timedOut: false }
        }
        const last = this.ring.slice(start, maxBytes)
        return { data: Buffer.alloc(0), from: last.from, to: last.to, dropped: last.dropped, timedOut: true }
    }

    expect ({ pattern, flags, from, timeoutMs } = {}) {
        let regex
        try {
            regex = new RegExp(pattern, flags || '')
        } catch (error) {
            return Promise.reject(new Error(`invalid regular expression: ${error.message}`))
        }

        const requested = Number.isFinite(from) ? from : this.readCursor
        const startedAt = Date.now()
        let cursor = Math.max(this.ring.base, Math.min(requested, this.ring.end))
        const dropped = Math.max(0, requested - cursor)
        let text = ''
        const decoder = new StringDecoder('utf8')

        const pump = () => {
            const slice = this.ring.slice(cursor, 4 * 1024 * 1024)
            if (slice.to > slice.from) {
                cursor = slice.to
                try {
                    text += decoder.write(slice.data)
                } catch { /* ignore malformed input */ }
                if (text.length > MAX_EXPECT_ACCUMULATION) {
                    text = text.slice(-MAX_EXPECT_ACCUMULATION)
                }
            }
        }

        const match = () => {
            pump()
            regex.lastIndex = 0
            const found = regex.exec(text)
            if (!found) {
                return null
            }
            return {
                matched: true,
                timedOut: false,
                match: found[0],
                groups: found.slice(1),
                index: found.index,
                context: text.slice(Math.max(0, found.index - 160), Math.min(text.length, found.index + found[0].length + 240)),
                text: text.length > MAX_EXPECT_TEXT ? text.slice(-MAX_EXPECT_TEXT) : text,
                dropped,
                elapsedMs: Date.now() - startedAt,
            }
        }

        pump()
        return this.waitFor(match, timeoutMs).then(result => {
            this.readCursor = this.ring.end
            if (result) {
                return result
            }
            return {
                matched: false,
                timedOut: true,
                dropped,
                text: text.length > MAX_EXPECT_TEXT ? text.slice(-MAX_EXPECT_TEXT) : text,
                elapsedMs: Date.now() - startedAt,
            }
        })
    }

    info (activeTab, topTab) {
        return {
            id: this.id,
            port: this.port,
            baudRate: this.baudRate,
            dataBits: this.options.databits ?? null,
            stopBits: this.options.stopbits ?? null,
            parity: this.options.parity ?? null,
            title: this.title,
            open: this.isOpen,
            rendered: !!this.session,
            attached: !!this.subscription,
            active: topTab ? topTab === activeTab : this.tab === activeTab,
            rxBytes: this.rxBytes,
            txBytes: this.txBytes,
            bufferedBytes: this.ring.length,
            bufferStart: this.ring.base,
            bufferEnd: this.ring.end,
            unreadBytes: Math.max(0, this.ring.end - this.readCursor),
        }
    }
}

class Registry {
    constructor ({ app, config, log }) {
        this.app = app
        this.config = config
        this.log = log || (() => {})
        this.targets = []
        this.byTab = new Map()
    }

    sync () {
        const seen = new Set()
        const tops = this.app && Array.isArray(this.app.tabs) ? this.app.tabs.slice() : []

        for (const top of tops) {
            let tabs = [top]
            try {
                if (typeof top.getAllTabs === 'function') {
                    tabs = top.getAllTabs()
                }
            } catch { /* ignore */ }

            for (const tab of tabs) {
                if (!isSerialTab(tab)) {
                    continue
                }
                seen.add(tab)
                if (!this.byTab.has(tab)) {
                    const target = new SerialTarget(this, tab)
                    this.byTab.set(tab, target)
                    this.targets.push(target)
                    this.log(`attached ${target.id} ${target.port} @${target.baudRate}`)
                }
            }
        }

        for (const [tab, target] of [...this.byTab.entries()]) {
            if (!seen.has(tab) || isDestroyedTab(tab)) {
                target.detach()
                this.byTab.delete(tab)
                this.targets = this.targets.filter(candidate => candidate !== target)
                this.log(`detached ${target.id} ${target.port}`)
            }
        }

        for (const target of this.targets) {
            target.attach()
        }

        return this.targets
    }

    findTop (tab) {
        const tops = this.app && Array.isArray(this.app.tabs) ? this.app.tabs : []
        for (const top of tops) {
            if (top === tab) {
                return top
            }
            try {
                if (typeof top.getAllTabs === 'function' && top.getAllTabs().includes(tab)) {
                    return top
                }
            } catch { /* ignore */ }
        }
        return null
    }

    resolve (query) {
        const targets = this.sync()
        if (!targets.length) {
            throw new Error('No open serial tab. Call serial_open to create one, or open a serial connection in Tabby first.')
        }

        const wanted = query === undefined || query === null ? '' : String(query).trim()
        const activeTab = this.app && this.app.activeTab

        if (!wanted || ['active', 'current', 'this'].includes(wanted.toLowerCase())) {
            const direct = targets.find(target => target.tab === activeTab)
            if (direct) {
                return direct
            }
            const nested = targets.find(target => this.findTop(target.tab) === activeTab)
            if (nested) {
                return nested
            }
            if (targets.length === 1) {
                return targets[0]
            }
            throw new Error(`Several serial tabs are open (${targets.map(target => `${target.id}=${target.port}`).join(', ')}); pass "target" explicitly.`)
        }

        const lower = wanted.toLowerCase()
        const byId = targets.find(target => target.id.toLowerCase() === lower)
        if (byId) {
            return byId
        }
        const byPort = targets.find(target => (target.port || '').toLowerCase() === lower)
        if (byPort) {
            return byPort
        }
        const byTitle = targets.find(target => target.title.toLowerCase() === lower)
        if (byTitle) {
            return byTitle
        }
        const indexed = /^#?(\d+)$/.exec(wanted)
        if (indexed && targets[Number(indexed[1])]) {
            return targets[Number(indexed[1])]
        }

        throw new Error(`Unknown serial target "${wanted}". Available: ${targets.map(target => `${target.id}=${target.port}`).join(', ')}`)
    }

    close () {
        for (const target of this.targets) {
            target.detach()
        }
        this.targets = []
        this.byTab.clear()
    }
}

module.exports = { Registry, SerialTarget, isSerialTab, visible }
