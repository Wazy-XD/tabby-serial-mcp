'use strict'

/**
 * A byte ring buffer addressed by absolute stream offsets.
 *
 * `base`   absolute offset of the first byte still held in memory
 * `total`  absolute offset one-past-the-last byte ever pushed
 *
 * Dropping whole chunks from the front keeps `slice()` cheap and makes the
 * "I lost data because it fell out of the ring" case explicit for the caller.
 */
class RingBuffer {
    constructor (maxBytes) {
        this.maxBytes = Math.max(64 * 1024, Number(maxBytes) || 4 * 1024 * 1024)
        this.chunks = []
        this.length = 0
        this.base = 0
        this.total = 0
    }

    push (buf) {
        if (!buf || !buf.length) {
            return
        }
        this.chunks.push(buf)
        this.length += buf.length
        this.total += buf.length
        while (this.length > this.maxBytes && this.chunks.length > 1) {
            const dropped = this.chunks.shift()
            this.length -= dropped.length
            this.base += dropped.length
        }
    }

    get end () {
        return this.base + this.length
    }

    /**
     * @param {number} from absolute offset, clamped into the retained window
     * @param {number} [maxBytes]
     * @returns {{ data: Buffer, from: number, to: number, dropped: number }}
     */
    slice (from, maxBytes) {
        const requested = Number.isFinite(from) ? from : this.base
        const start = Math.max(this.base, Math.min(requested, this.total))
        const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : Infinity
        const end = Math.min(this.total, start + limit)

        const parts = []
        let offset = this.base
        for (const chunk of this.chunks) {
            const chunkStart = offset
            const chunkEnd = offset + chunk.length
            offset = chunkEnd
            if (chunkEnd <= start) {
                continue
            }
            if (chunkStart >= end) {
                break
            }
            parts.push(chunk.subarray(Math.max(0, start - chunkStart), Math.min(chunk.length, end - chunkStart)))
        }

        return {
            data: parts.length === 1 ? parts[0] : Buffer.concat(parts),
            from: start,
            to: end,
            dropped: Math.max(0, start - requested),
        }
    }

    clear () {
        this.chunks = []
        this.length = 0
        this.base = this.total
    }
}

module.exports = { RingBuffer }
