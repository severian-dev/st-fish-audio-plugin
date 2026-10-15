import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { AudioCache } from '../lib/cache.js';

describe('AudioCache', () => {
    let root;
    before(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'fish-cache-test-')); });
    after(async () => { await fs.rm(root, { recursive: true, force: true }); });

    it('derives the same key for equal requests and different keys otherwise', () => {
        const a = AudioCache.keyFor('s2.1-pro-free', { text: 'Hi', reference_id: 'x', format: 'mp3' });
        const b = AudioCache.keyFor('s2.1-pro-free', { text: 'Hi', reference_id: 'x', format: 'mp3' });
        const c = AudioCache.keyFor('s2.1-pro', { text: 'Hi', reference_id: 'x', format: 'mp3' });
        const d = AudioCache.keyFor('s2.1-pro-free', { text: 'Hi', reference_id: 'y', format: 'mp3' });
        assert.equal(a, b);
        assert.notEqual(a, c);
        assert.notEqual(a, d);
        assert.match(a, /^[0-9a-f]{64}$/);
    });

    it('stores per user and misses for other users', async () => {
        const cache = new AudioCache({ root });
        const key = AudioCache.keyFor('m', { text: 'one' });
        await cache.put('alice', key, Buffer.from('audio'));
        assert.equal((await cache.get('alice', key))?.toString(), 'audio');
        assert.equal(await cache.get('bob', key), null);
        assert.deepEqual(await cache.stats('alice'), { files: 1, bytes: 5 });
    });

    it('keeps user folders inside the root', () => {
        const cache = new AudioCache({ root });
        assert.equal(path.dirname(cache.dirFor('../../etc')), root);
        assert.throws(() => cache.fileFor('alice', '../x'));
    });

    it('evicts least recently used files past the cap', async () => {
        const cache = new AudioCache({ root, maxBytesPerUser: 10 });
        const k1 = AudioCache.keyFor('m', { text: '1' });
        const k2 = AudioCache.keyFor('m', { text: '2' });
        const k3 = AudioCache.keyFor('m', { text: '3' });
        await cache.put('carol', k1, Buffer.alloc(4));
        await new Promise(r => setTimeout(r, 20));
        await cache.put('carol', k2, Buffer.alloc(4));
        await new Promise(r => setTimeout(r, 20));
        await cache.get('carol', k1); // touch k1, so k2 is now the oldest
        await new Promise(r => setTimeout(r, 20));
        await cache.put('carol', k3, Buffer.alloc(4));
        assert.notEqual(await cache.get('carol', k1), null);
        assert.equal(await cache.get('carol', k2), null);
        assert.notEqual(await cache.get('carol', k3), null);
    });

    it('clears a user', async () => {
        const cache = new AudioCache({ root });
        await cache.put('dave', AudioCache.keyFor('m', { text: 'x' }), Buffer.from('a'));
        await cache.clear('dave');
        assert.deepEqual(await cache.stats('dave'), { files: 0, bytes: 0 });
    });
});
