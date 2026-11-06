'use strict'

const fs = require('fs')
const path = require('path')

const DEFAULTS = {
    enabled: true,
    host: '127.0.0.1',
    port: 3002,
    echoAgentWrites: true,
    ringBufferBytes: 4 * 1024 * 1024,
    defaultReadTimeoutMs: 15000,
    maxReadBytes: 1024 * 1024,
    logRequests: false,
}

class ConfigStore {
    constructor (dir) {
        this.dir = dir
        this.file = path.join(dir, 'serial-mcp.json')
        this.values = { ...DEFAULTS }
        this.lastError = null
        this.load()
    }

    load () {
        try {
            const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
            for (const key of Object.keys(DEFAULTS)) {
                if (parsed[key] !== undefined && parsed[key] !== null) {
                    this.values[key] = parsed[key]
                }
            }
        } catch (error) {
            if (error.code !== 'ENOENT') {
                this.lastError = `cannot read ${this.file}: ${error.message}`
            }
        }
    }

    save () {
        try {
            fs.mkdirSync(this.dir, { recursive: true })
            fs.writeFileSync(this.file, JSON.stringify(this.values, null, 2), 'utf8')
            this.lastError = null
            return true
        } catch (error) {
            this.lastError = `cannot write ${this.file}: ${error.message}`
            return false
        }
    }

    get (key) {
        return this.values[key]
    }

    set (key, value) {
        this.values[key] = value
    }
}

module.exports = { DEFAULTS, ConfigStore }
