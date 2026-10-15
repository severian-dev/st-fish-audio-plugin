// Caps concurrent Fish requests per API key. Fish allows 5 at once on the base
// tier and answers 429 past that, with no Retry-After header.

export class KeyedLimiter {
    /** @param {number} limit Slots per key */
    constructor(limit) {
        this.limit = limit;
        /** @type {Map<string, {active: number, waiting: Array<() => void>}>} */
        this.slots = new Map();
    }

    /**
     * Waits for a free slot. Resolves to a release function, call it exactly once.
     * @param {string} key
     * @param {AbortSignal} [signal] Aborting while queued rejects and gives up the place in line
     * @returns {Promise<() => void>}
     */
    acquire(key, signal) {
        let entry = this.slots.get(key);
        if (!entry) {
            entry = { active: 0, waiting: [] };
            this.slots.set(key, entry);
        }
        const slot = entry;

        const release = () => {
            slot.active--;
            const next = slot.waiting.shift();
            if (next) {
                next();
            } else if (slot.active === 0) {
                this.slots.delete(key);
            }
        };

        if (slot.active < this.limit) {
            slot.active++;
            return Promise.resolve(once(release));
        }

        return new Promise((resolve, reject) => {
            const grant = () => {
                signal?.removeEventListener('abort', onAbort);
                slot.active++;
                resolve(once(release));
            };
            const onAbort = () => {
                const index = slot.waiting.indexOf(grant);
                if (index !== -1) slot.waiting.splice(index, 1);
                reject(signal?.reason ?? new Error('aborted'));
            };
            if (signal?.aborted) return onAbort();
            signal?.addEventListener('abort', onAbort, { once: true });
            slot.waiting.push(grant);
        });
    }
}

/** @param {() => void} fn */
function once(fn) {
    let called = false;
    return () => {
        if (called) return;
        called = true;
        fn();
    };
}
