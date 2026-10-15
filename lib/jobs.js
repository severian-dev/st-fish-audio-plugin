// In-memory store for synthesis jobs.
// POST /tts starts a Fish request and returns a job id. GET /tts/:id streams
// the job's audio, replaying what has already arrived and then following live
// chunks. SillyTavern's TTS plays a URL as the audio element's src, so this is
// what lets playback start on the first chunk instead of after the whole clip.

import { randomUUID } from 'node:crypto';

/**
 * @typedef {object} Job
 * @property {string} id
 * @property {string} owner User handle that created the job
 * @property {Buffer[]} chunks
 * @property {number} size Bytes received so far
 * @property {boolean} done
 * @property {string|null} error
 * @property {Set<(event: 'data'|'end', chunk?: Buffer) => void>} listeners
 * @property {number} createdAt
 * @property {number|null} finishedAt
 */

export class JobStore {
    /**
     * @param {object} [options]
     * @param {number} [options.ttlMs] How long a finished job stays fetchable
     * @param {number} [options.maxAgeMs] Hard cap on any job's lifetime
     * @param {number} [options.maxBytes] Total buffered bytes before old finished jobs are evicted
     * @param {() => number} [options.now] Clock, for tests
     */
    constructor({ ttlMs = 30 * 60_000, maxAgeMs = 2 * 60 * 60_000, maxBytes = 200 * 1024 * 1024, now = Date.now } = {}) {
        /** @type {Map<string, Job>} */
        this.jobs = new Map();
        this.ttlMs = ttlMs;
        this.maxAgeMs = maxAgeMs;
        this.maxBytes = maxBytes;
        this.now = now;
    }

    /**
     * @param {string} owner
     * @returns {Job}
     */
    create(owner) {
        const job = {
            id: randomUUID(),
            owner,
            chunks: [],
            size: 0,
            done: false,
            error: null,
            listeners: new Set(),
            createdAt: this.now(),
            finishedAt: null,
        };
        this.jobs.set(job.id, job);
        return job;
    }

    /**
     * Returns the job only to the user who created it.
     * @param {string} id
     * @param {string} owner
     */
    get(id, owner) {
        const job = this.jobs.get(id);
        return job && job.owner === owner ? job : null;
    }

    /** @param {Job} job @param {Buffer} chunk */
    push(job, chunk) {
        if (job.done) return;
        job.chunks.push(chunk);
        job.size += chunk.length;
        for (const listener of job.listeners) listener('data', chunk);
    }

    /** @param {Job} job @param {string|null} [error] */
    finish(job, error = null) {
        if (job.done) return;
        job.done = true;
        job.error = error;
        job.finishedAt = this.now();
        // Finished jobs hold one buffer so replays and range requests are cheap.
        if (job.chunks.length > 1) job.chunks = [Buffer.concat(job.chunks)];
        for (const listener of job.listeners) listener('end');
        job.listeners.clear();
        this.sweep();
    }

    /** Drops expired jobs, then the oldest finished ones while over the byte cap. */
    sweep() {
        const now = this.now();
        for (const [id, job] of this.jobs) {
            const expired = job.done
                ? now - /** @type {number} */ (job.finishedAt) > this.ttlMs
                : now - job.createdAt > this.maxAgeMs;
            if (expired) this.drop(id);
        }
        let total = 0;
        for (const job of this.jobs.values()) total += job.size;
        if (total <= this.maxBytes) return;
        const finished = [...this.jobs.values()]
            .filter(j => j.done)
            .sort((a, b) => /** @type {number} */ (a.finishedAt) - /** @type {number} */ (b.finishedAt));
        for (const job of finished) {
            if (total <= this.maxBytes) break;
            total -= job.size;
            this.drop(job.id);
        }
    }

    /** @param {string} id */
    drop(id) {
        const job = this.jobs.get(id);
        if (!job) return;
        for (const listener of job.listeners) listener('end');
        job.listeners.clear();
        this.jobs.delete(id);
    }

    clear() {
        for (const id of [...this.jobs.keys()]) this.drop(id);
    }
}
