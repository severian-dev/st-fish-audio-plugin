// On-disk audio cache, one folder per SillyTavern user. A line spoken again
// with the same voice and settings is served from disk instead of costing
// credit. Least recently used files go first once a user's folder passes the cap.

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const KEY_RE = /^[0-9a-f]{64}$/;

export class AudioCache {
    /**
     * @param {object} options
     * @param {string} options.root Folder holding one subfolder per user
     * @param {number} [options.maxBytesPerUser]
     */
    constructor({ root, maxBytesPerUser = 200 * 1024 * 1024 }) {
        this.root = root;
        this.maxBytesPerUser = maxBytesPerUser;
    }

    /**
     * Cache key for a validated request. buildTtsRequest emits fields in a
     * fixed order, so the JSON is stable for equal requests.
     * @param {string} model
     * @param {Record<string, unknown>} body
     */
    static keyFor(model, body) {
        return createHash('sha256').update(JSON.stringify(['v1', model, body])).digest('hex');
    }

    /** @param {string} owner User handle */
    dirFor(owner) {
        const safe = String(owner).replace(/[^a-z0-9_-]/gi, '_') || '_';
        return path.join(this.root, safe);
    }

    /** @param {string} owner @param {string} key */
    fileFor(owner, key) {
        if (!KEY_RE.test(key)) throw new Error('bad cache key');
        return path.join(this.dirFor(owner), `${key}.mp3`);
    }

    /**
     * @param {string} owner
     * @param {string} key
     * @returns {Promise<Buffer|null>}
     */
    async get(owner, key) {
        const file = this.fileFor(owner, key);
        try {
            const buffer = await fs.readFile(file);
            const now = new Date();
            await fs.utimes(file, now, now).catch(() => {});
            return buffer.length ? buffer : null;
        } catch {
            return null;
        }
    }

    /**
     * Writes atomically (temp file, then rename), then trims the folder.
     * @param {string} owner
     * @param {string} key
     * @param {Buffer} buffer
     */
    async put(owner, key, buffer) {
        if (!buffer.length || buffer.length > this.maxBytesPerUser) return;
        const file = this.fileFor(owner, key);
        await fs.mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
        await fs.writeFile(tmp, buffer);
        await fs.rename(tmp, file);
        await this.prune(owner);
    }

    /** @param {string} owner */
    async entries(owner) {
        const dir = this.dirFor(owner);
        let names;
        try {
            names = await fs.readdir(dir);
        } catch {
            return [];
        }
        const out = [];
        for (const name of names) {
            if (!name.endsWith('.mp3')) continue;
            try {
                const stat = await fs.stat(path.join(dir, name));
                out.push({ file: path.join(dir, name), size: stat.size, mtime: stat.mtimeMs });
            } catch {
                // removed meanwhile
            }
        }
        return out;
    }

    /** Deletes least recently used files until the folder fits the cap. @param {string} owner */
    async prune(owner) {
        const entries = (await this.entries(owner)).sort((a, b) => a.mtime - b.mtime);
        let total = entries.reduce((sum, e) => sum + e.size, 0);
        for (const entry of entries) {
            if (total <= this.maxBytesPerUser) break;
            await fs.rm(entry.file, { force: true });
            total -= entry.size;
        }
    }

    /** @param {string} owner */
    async stats(owner) {
        const entries = await this.entries(owner);
        return { files: entries.length, bytes: entries.reduce((sum, e) => sum + e.size, 0) };
    }

    /** @param {string} owner */
    async clear(owner) {
        await fs.rm(this.dirFor(owner), { recursive: true, force: true });
    }
}
