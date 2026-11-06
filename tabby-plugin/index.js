'use strict'

/**
 * tabby-serial-mcp
 *
 * A Tabby plugin that exposes the raw byte stream of every open serial tab over
 * a local MCP endpoint, and can open new serial tabs on request.
 *
 * It is plain CommonJS on purpose: Tabby loads user plugins with `require()` and
 * resolves `tabby-core` / `tabby-terminal` / Angular through the host's module
 * cache, so no webpack build step is needed. Angular metadata is applied by
 * calling the decorators directly.
 */

const path = require('path')
const os = require('os')

const { NgModule, APP_INITIALIZER, Injector } = require('@angular/core')
const { CommonModule } = require('@angular/common')
const { SettingsTabProvider } = require('tabby-settings')
const { AppService, BOOTSTRAP_DATA } = require('tabby-core')

const { createBridge } = require('./lib/bridge')
const { SerialMcpSettingsComponent, SerialMcpSettingsTabProvider } = require('./lib/settings-tab')

function fallbackUserDataDir () {
    const base = process.env.APPDATA || path.join(os.homedir(), '.config')
    return path.join(base, 'tabby')
}

function bootFactory (app, injector, bootstrapData) {
    return () => {
        try {
            const userPluginsPath = bootstrapData && bootstrapData.userPluginsPath
            const userDataDir = userPluginsPath ? path.dirname(userPluginsPath) : fallbackUserDataDir()
            const bridge = createBridge({ app, injector, userDataDir })
            console.log(`[serial-mcp] bridge ready, state=${bridge.state}`)
        } catch (error) {
            console.error('[serial-mcp] failed to start the bridge:', error)
        }
    }
}

class SerialMcpModule {}

NgModule({
    imports: [
        CommonModule,
    ],
    providers: [
        { provide: SettingsTabProvider, useClass: SerialMcpSettingsTabProvider, multi: true },
        {
            provide: APP_INITIALIZER,
            multi: true,
            deps: [AppService, Injector, BOOTSTRAP_DATA],
            useFactory: bootFactory,
        },
    ],
    declarations: [
        SerialMcpSettingsComponent,
    ],
})(SerialMcpModule)

module.exports = { default: SerialMcpModule }
