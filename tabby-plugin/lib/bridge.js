'use strict'

const path = require('path')
const fs = require('fs')
const { ConfigStore } = require('./config')
const { Registry } = require('./sessions')
const { createMcpServer } = require('./mcp-server')
const { createTools } = require('./tools')

const INSTRUCTIONS = `The user is running Tabby (a terminal app) and has serial connections open in it, or wants new ones.
All tools operate on a *serial tab*: a live serial connection that the user can also see and type into.

Targeting: every tool takes an optional "target". Use the "id" reported by serial_list_tabs (e.g. "s1"), or a port name such as "COM13". Omit it when exactly one serial tab is open.

Typical flow:
1. serial_list_ports -> pick a port; serial_list_tabs -> see what is already connected.
2. serial_open { port, baudRate } to create a tab, or reuse an id from serial_list_tabs.
3. serial_write { data: "AT+CSQ\\r\\n" } or { hex: "41 54 0D 0A" } to send raw bytes.
4. serial_read { timeoutMs: 1000 } to collect the reply, or serial_expect { pattern: "^\\\\+CSQ: \\\\d+,", write: "AT+CSQ\\\\r\\\\n" } to wait for a specific answer.

Notes:
- The agent and the human share one port; both directions are raw bytes. Data received before this plugin attached is not in the buffer, so bufferStart/bufferEnd tell you what is still available.
- Writes are echoed into the tab as a dim "[agent -> N B]" line; the device never receives that line.
- serial_annotate prints a note in the tab for the human; it is never sent to the device.`

function delay (ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Tabby's renderer console is not visible to the user, so mirror every message
 * into a small log file next to the config. This is the only way to diagnose a
 * plugin that fails while Tabby starts.
 */
function makeLogger (userDataDir) {
    const file = path.join(userDataDir, 'serial-mcp.log')
    let stream = null
    try {
        fs.mkdirSync(userDataDir, { recursive: true })
        try {
            const stat = fs.statSync(file)
            if (stat.size > 2 * 1024 * 1024) {
                fs.renameSync(file, `${file}.1`)
            }
        } catch { /* no previous log */ }
        stream = fs.createWriteStream(file, { flags: 'a' })
    } catch { /* logging is optional */ }

    return message => {
        const line = `[${new Date().toISOString()}] ${message}\n`
        try {
            console.log(`[serial-mcp] ${message}`)
        } catch { /* ignore */ }
        if (stream) {
            try {
                stream.write(line)
            } catch { /* ignore */ }
        }
    }
}

class Bridge {
    constructor ({ app, injector, userDataDir, log }) {
        this.app = app
        this.injector = injector
        this.log = log || makeLogger(userDataDir)
        this.config = new ConfigStore(userDataDir)
        this.registry = new Registry({ app, config: this.config, log: this.log })
        this.server = createMcpServer({
            tools: createTools(this),
            instructions: INSTRUCTIONS,
            version: '1.0.0',
            log: this.log,
        })
        this.state = 'idle'
        this.lastStartError = null
        this.settingsCheck = 'unchecked'
        this.syncTimer = null
        this.startedAt = null
    }

    get tabbyCore () {
        // Loaded lazily so the module can be required outside Tabby (tests, tooling).
        return require('tabby-core')
    }

    profileProviders () {
        try {
            const { ProfileProvider } = this.tabbyCore
            const providers = this.injector.get(ProfileProvider)
            return Array.isArray(providers) ? providers : [providers]
        } catch (error) {
            return []
        }
    }

    serialProvider () {
        return this.profileProviders().find(provider => provider && provider.id === 'serial') || null
    }

    async listPorts () {
        try {
            const { autoDetect } = require('@serialport/bindings-cpp')
            const found = await autoDetect().list()
            if (found.length) {
                return found.map(port => ({
                    path: port.path,
                    label: port.friendlyName || port.path,
                    manufacturer: port.manufacturer || null,
                    serialNumber: port.serialNumber || null,
                    vendorId: port.vendorId || null,
                    productId: port.productId || null,
                }))
            }
        } catch (error) {
            this.log(`@serialport/bindings-cpp list failed: ${error.message}`)
        }

        const provider = this.serialProvider()
        if (provider) {
            try {
                const profiles = await provider.getBuiltinProfiles()
                const ports = []
                for (const profile of profiles) {
                    const port = profile && profile.options && profile.options.port
                    if (!port || profile.isTemplate) {
                        continue
                    }
                    if (ports.some(candidate => candidate.path === port)) {
                        continue
                    }
                    ports.push({ path: port, label: port })
                }
                return ports
            } catch (error) {
                this.log(`serial profile provider failed: ${error.message}`)
            }
        }
        return []
    }

    async openSerial (options) {
        const provider = this.serialProvider()
        if (!provider) {
            throw new Error('the built-in Tabby serial plugin (tabby-serial) is not available')
        }

        const profile = {
            id: `serial:port-${String(options.port).toLowerCase()}`,
            type: 'serial',
            name: options.title || `${options.port} @${options.baudRate}`,
            icon: 'fas fa-microchip',
            options: {
                port: options.port,
                baudrate: options.baudRate,
                databits: options.dataBits,
                stopbits: options.stopBits,
                parity: options.parity,
                rtscts: false,
                xon: false,
                xoff: false,
                xany: false,
                inputMode: null,
                outputMode: null,
                inputNewlines: null,
                outputNewlines: null,
                scripts: [],
                slowSend: false,
                input: { backspace: 'backspace' },
            },
            clearServiceMessagesOnConnect: false,
        }

        const params = await provider.getNewTabParameters(profile)
        if (!params || !params.type) {
            throw new Error('the serial profile provider did not return tab parameters')
        }

        const before = new Set(this.registry.sync().map(target => target.tab))
        this.log(`openSerial: port=${options.port} baud=${options.baudRate} type=${params.type.name || '?'} existingTargets=${before.size}`)

        // Plain top-level tab: no SplitTabComponent wrapper, so the tab body is
        // rendered (and the serial session created) as soon as it becomes active.
        const opened = this.app.openNewTabRaw(params)
        this.log(`openSerial: created ${opened && opened.constructor ? opened.constructor.name : typeof opened}`)

        const deadline = Date.now() + 20000
        let target = null
        let dumped = false
        while (Date.now() < deadline) {
            this.registry.sync()
            target = this.registry.targets.find(candidate => !before.has(candidate.tab) && (candidate.port || '').toLowerCase() === options.port.toLowerCase())
                || this.registry.targets.find(candidate => !before.has(candidate.tab))
            if (target && target.isOpen) {
                break
            }
            if (!target && !dumped && Date.now() > deadline - 17000) {
                dumped = true
                try {
                    this.log(`openSerial: no serial tab yet; tabs=${JSON.stringify((this.app.tabs || []).map(tab => ({
                        kind: tab.constructor && tab.constructor.name,
                        profile: tab.profile && tab.profile.type,
                        hasSession: !!tab.session,
                    })))}`)
                } catch (error) {
                    this.log(`openSerial: cannot dump tabs: ${error.message}`)
                }
            }
            await delay(80)
        }

        if (!target) {
            throw new Error(`the serial tab for ${options.port} never appeared`)
        }
        if (!target.isOpen) {
            throw new Error(`could not open ${options.port}: the port is closed, busy, or already open in another tab`)
        }

        return {
            id: target.id,
            port: target.port,
            baudRate: target.baudRate,
            title: target.title,
            open: true,
        }
    }

    async closeTarget (target) {
        const tab = target.tab
        const top = this.registry.findTop(tab) || tab
        let siblings = 1
        try {
            if (top !== tab && typeof top.getAllTabs === 'function') {
                siblings = top.getAllTabs().length
            }
        } catch { /* ignore */ }

        if (top !== tab && siblings > 1) {
            tab.destroy()
        } else {
            await this.app.closeTab(top, false, true)
        }
        this.registry.sync()
    }

    async start () {
        if (!this.config.get('enabled')) {
            this.state = 'disabled'
            return this.status()
        }
        if (this.server.running) {
            this.state = 'running'
            return this.status()
        }
        try {
            await this.server.start(this.config.get('host'), this.config.get('port'))
            this.state = 'running'
            this.startedAt = Date.now()
            this.lastStartError = null
        } catch (error) {
            this.state = 'error'
            this.lastStartError = error.message
            this.log(`cannot start the MCP server: ${error.message}`)
        }
        return this.status()
    }

    async stop () {
        await this.server.stop()
        this.state = 'stopped'
        this.startedAt = null
        return this.status()
    }

    async restart () {
        await this.stop()
        return this.start()
    }

    boot () {
        this.log(`boot: userData=${this.config.dir} config=${this.config.file}`)
        try {
            this.registry.sync()
            this.log(`boot: ${this.registry.targets.length} serial tab(s) attached`)
        } catch (error) {
            this.log(`initial sync failed: ${error.message}`)
        }

        try {
            if (this.app && this.app.tabOpened$ && typeof this.app.tabOpened$.subscribe === 'function') {
                this.app.tabOpened$.subscribe(() => {
                    try {
                        this.registry.sync()
                    } catch { /* ignore */ }
                })
            }
        } catch (error) {
            this.log(`cannot watch tabOpened$: ${error.message}`)
        }

        // Sessions are created a tick after their tab appears, so keep sweeping.
        this.syncTimer = setInterval(() => {
            try {
                this.registry.sync()
            } catch { /* ignore */ }
        }, 1000)
        if (this.syncTimer && typeof this.syncTimer.unref === 'function') {
            this.syncTimer.unref()
        }

        this.start()
            .then(() => this.log(`boot: server state=${this.state} url=${this.server.health().url || '-'}`))
            .catch(error => this.log(`start failed: ${error.message}`))

        this.checkSettingsComponent()
    }

    /**
     * JIT-compile the settings component once at boot so a broken template shows
     * up in serial-mcp.log instead of a blank settings page.
     */
    checkSettingsComponent () {
        try {
            const { ComponentFactoryResolver } = require('@angular/core')
            const { SerialMcpSettingsComponent } = require('./settings-tab')
            this.injector.get(ComponentFactoryResolver).resolveComponentFactory(SerialMcpSettingsComponent)
            this.settingsCheck = 'ok'
        } catch (error) {
            this.settingsCheck = `error: ${error.message}`
        }
        this.log(`settings component: ${this.settingsCheck}`)
    }

    dispose () {
        if (this.syncTimer) {
            clearInterval(this.syncTimer)
            this.syncTimer = null
        }
        this.registry.close()
        this.server.stop().catch(() => {})
    }

    /** Current Tabby UI language, e.g. "zh-CN". */
    locale () {
        try {
            const { LocaleService } = this.tabbyCore
            if (LocaleService) {
                const service = this.injector.get(LocaleService)
                const code = service && typeof service.getLocale === 'function' ? service.getLocale() : null
                if (code) {
                    return code
                }
            }
        } catch { /* fall through */ }
        try {
            return Intl.DateTimeFormat().resolvedOptions().locale || 'en-US'
        } catch {
            return 'en-US'
        }
    }

    /** "zh" or "en" — the only two languages the plugin ships. */
    lang () {
        return String(this.locale() || '').toLowerCase().startsWith('zh') ? 'zh' : 'en'
    }

    status () {
        const health = this.server.health()
        let attached = 0
        try {
            attached = this.registry.sync().length
        } catch { /* ignore */ }
        return {
            enabled: !!this.config.get('enabled'),
            state: this.state,
            running: this.server.running,
            url: health.url,
            host: health.host || this.config.get('host'),
            port: health.port || this.config.get('port'),
            requests: health.requests,
            errors: health.errors,
            lastError: health.lastError || this.lastStartError || this.config.lastError,
            startedAt: this.startedAt,
            attached,
            settingsComponent: this.settingsCheck,
            tools: health.tools,
            configFile: this.config.file,
            config: { ...this.config.values },
        }
    }
}

function getBridge () {
    return global.__tabbySerialMcpBridge || null
}

function createBridge (dependencies) {
    if (!global.__tabbySerialMcpBridge) {
        const bridge = new Bridge(dependencies)
        global.__tabbySerialMcpBridge = bridge
        bridge.boot()
    }
    return global.__tabbySerialMcpBridge
}

module.exports = { Bridge, createBridge, getBridge, INSTRUCTIONS, delay }
