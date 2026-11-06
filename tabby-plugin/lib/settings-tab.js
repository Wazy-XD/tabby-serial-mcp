'use strict'

const { Component } = require('@angular/core')
const { SettingsTabProvider } = require('tabby-settings')
const { getBridge } = require('./bridge')

const STRINGS = {
    en: {
        tabTitle: 'Serial MCP',
        heading: 'Serial MCP bridge',
        intro: 'Lets an MCP client (DeepSeek Harness) read and write raw bytes on your open serial tabs, and open new ones. Both sides share the same port, so you can keep typing in the tab while the agent works.',
        status: 'Status',
        running: 'Running',
        stopped: 'Stopped',
        disabled: 'Disabled',
        restart: 'Restart server',
        endpoint: 'MCP endpoint',
        listenPort: 'Listen port',
        portHint: 'changing it restarts the server',
        tabs: 'Serial tabs',
        attached: 'attached',
        requests: 'Requests',
        handled: 'ok',
        failed: 'failed',
        echo: 'Echo agent writes',
        echoHint: 'print a dim line in the tab whenever the agent sends bytes',
        lastError: 'Last error',
        configFile: 'Config file',
        setup: 'In DeepSeek Harness add this as a streamable-http MCP server; its tools appear as',
    },
    zh: {
        tabTitle: '串口 MCP',
        heading: '串口 MCP 桥接',
        intro: '让 MCP 客户端（DeepSeek Harness）读写你已打开的串口标签页，也能新建串口页。两侧共用同一个端口，agent 工作时你可以继续在窗口里敲字。',
        status: '状态',
        running: '运行中',
        stopped: '已停止',
        disabled: '已禁用',
        restart: '重启服务',
        endpoint: 'MCP 地址',
        listenPort: '监听端口',
        portHint: '修改后自动重启服务',
        tabs: '串口标签页',
        attached: '个已接入',
        requests: '请求',
        handled: '次成功',
        failed: '次失败',
        echo: '回显 agent 写入',
        echoHint: 'agent 每次发字节都在窗口里打印一行暗色提示',
        lastError: '最近错误',
        configFile: '配置文件',
        setup: '在 DeepSeek Harness 里把它添加成 streamable-http 类型的 MCP 服务器，工具名形如',
    },
}

const STYLES = `
.smcp { padding: 1rem 1.5rem; max-width: 62rem; }
.smcp h4 { margin: 0 0 .3rem; }
.smcp .smcp-hint { opacity: .72; font-size: .95em; margin: .2rem 0 .9rem; }
.smcp .smcp-row { display: flex; align-items: center; gap: .75rem; flex-wrap: wrap; margin: .45rem 0; }
.smcp .smcp-label { flex: 0 0 9.5rem; opacity: .7; }
.smcp .smcp-state { font-weight: 600; }
.smcp .smcp-state.on { color: #6ac46a; }
.smcp .smcp-state.off { color: #e06c75; }
.smcp .smcp-muted { opacity: .6; font-size: .9em; }
.smcp code { word-break: break-all; }
.smcp input[type="number"] { width: 7rem; }
`

const TEMPLATE = `
<div class="smcp">
    <h4>{{ t.heading }}</h4>
    <p class="smcp-hint">{{ t.intro }}</p>

    <div class="smcp-row">
        <span class="smcp-label">{{ t.status }}</span>
        <span class="smcp-state" [class.on]="status.running" [class.off]="!status.running">{{ stateText }}</span>
        <button class="btn btn-secondary btn-sm" (click)="restart()">{{ t.restart }}</button>
    </div>

    <div class="smcp-row">
        <span class="smcp-label">{{ t.endpoint }}</span>
        <code>{{ endpoint }}</code>
    </div>

    <div class="smcp-row">
        <span class="smcp-label">{{ t.listenPort }}</span>
        <input type="number" min="1" max="65535" [value]="status.config.port" (change)="onPortChange($event)">
        <span class="smcp-muted">{{ t.portHint }}</span>
    </div>

    <div class="smcp-row">
        <span class="smcp-label">{{ t.tabs }}</span>
        <span>{{ status.attached }} {{ t.attached }}</span>
    </div>

    <div class="smcp-row">
        <span class="smcp-label">{{ t.requests }}</span>
        <span>{{ status.requests }} {{ t.handled }} / {{ status.errors }} {{ t.failed }}</span>
    </div>

    <div class="smcp-row">
        <span class="smcp-label">{{ t.echo }}</span>
        <label>
            <input type="checkbox" [checked]="status.config.echoAgentWrites" (change)="onEchoChange($event)">
            {{ t.echoHint }}
        </label>
    </div>

    <div class="smcp-row" [hidden]="!status.lastError">
        <span class="smcp-label">{{ t.lastError }}</span>
        <span class="smcp-state off">{{ status.lastError }}</span>
    </div>

    <div class="smcp-row">
        <span class="smcp-label">{{ t.configFile }}</span>
        <code>{{ status.configFile }}</code>
    </div>

    <p class="smcp-hint">
        {{ t.setup }} <code>streamable-http</code> / <code>mcp__tabby__serial_*</code>
    </p>
</div>
`

function stringsFor (lang) {
    return STRINGS[lang] || STRINGS.en
}

class SerialMcpSettingsComponent {
    constructor () {
        this.status = { running: false, config: {}, attached: 0, requests: 0, errors: 0 }
        this.timer = null
    }

    // Re-evaluated on every change detection, so the page follows Tabby's language.
    get t () {
        const bridge = getBridge()
        return stringsFor(bridge && bridge.lang ? bridge.lang() : 'en')
    }

    get endpoint () {
        const status = this.status || {}
        const config = status.config || {}
        return status.url || `http://${config.host || '127.0.0.1'}:${config.port || 3002}/mcp`
    }

    get stateText () {
        const status = this.status || {}
        if (status.running) {
            return this.t.running
        }
        return status.state === 'disabled' ? this.t.disabled : this.t.stopped
    }

    ngOnInit () {
        this.refresh()
        this.timer = setInterval(() => this.refresh(), 1000)
    }

    ngOnDestroy () {
        if (this.timer) {
            clearInterval(this.timer)
            this.timer = null
        }
    }

    refresh () {
        const bridge = getBridge()
        this.status = bridge
            ? bridge.status()
            : { running: false, state: 'not started', config: {}, attached: 0, requests: 0, errors: 0, lastError: 'bridge was not initialised' }
    }

    async restart () {
        const bridge = getBridge()
        if (bridge) {
            await bridge.restart()
        }
        this.refresh()
    }

    onPortChange (event) {
        const bridge = getBridge()
        if (!bridge) {
            return
        }
        const port = parseInt(event.target.value, 10)
        if (!(port > 0 && port < 65536)) {
            this.refresh()
            return
        }
        bridge.config.set('port', port)
        bridge.config.save()
        bridge.restart().then(() => this.refresh())
    }

    onEchoChange (event) {
        const bridge = getBridge()
        if (!bridge) {
            return
        }
        bridge.config.set('echoAgentWrites', !!event.target.checked)
        bridge.config.save()
        this.refresh()
    }
}

Component({
    selector: 'serial-mcp-settings',
    template: TEMPLATE,
    styles: [STYLES],
    host: { class: 'content-box' },
})(SerialMcpSettingsComponent)

class SerialMcpSettingsTabProvider extends SettingsTabProvider {
    constructor () {
        super()
        const bridge = getBridge()
        this.id = 'serial-mcp'
        this.icon = 'plug'
        this.weight = 50
        this.title = stringsFor(bridge && bridge.lang ? bridge.lang() : 'en').tabTitle
    }

    getComponentType () {
        return SerialMcpSettingsComponent
    }
}

module.exports = { SerialMcpSettingsComponent, SerialMcpSettingsTabProvider, STRINGS }
