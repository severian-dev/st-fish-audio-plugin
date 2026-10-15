import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FishError, startTts, toFishError } from '../lib/fish.js';
import { JobStore } from '../lib/jobs.js';
import { KeyedLimiter } from '../lib/limiter.js';
import { buildTtsRequest, buildVoiceQuery, DEFAULT_MODEL, mapVoice, RequestError } from '../lib/validate.js';

const VOICE = 'f3a2b90078d54a65af4b95f63bc7798e';
const VOICE2 = 'd13f84b987ad4f22b56d2b47f4eb838e';

describe('buildTtsRequest', () => {
    it('defaults to the free model and forces mp3', () => {
        const { model, body } = buildTtsRequest({ text: 'Hello.', reference_id: VOICE, format: 'wav' });
        assert.equal(model, DEFAULT_MODEL);
        assert.deepEqual(body, { text: 'Hello.', reference_id: VOICE, format: 'mp3' });
    });

    it('rejects models outside the list instead of letting Fish bill them as s2.1-pro', () => {
        for (const model of ['speech-1.5', 'drama-3-preview', '', null, 's2.1-PRO']) {
            assert.throws(() => buildTtsRequest({ text: 'Hi', reference_id: VOICE, model }), RequestError);
        }
        assert.equal(buildTtsRequest({ text: 'Hi', reference_id: VOICE, model: 's2.1-pro' }).model, 's2.1-pro');
    });

    it('drops unknown fields and keeps checked ones', () => {
        const { body } = buildTtsRequest({
            text: 'Hi', reference_id: VOICE, temperature: 0.5, top_p: 0.9, latency: 'balanced',
            normalize: false, chunk_length: 200, mp3_bitrate: 192,
            prosody: { speed: 1.25, normalize_loudness: true, volume: 99 },
            seed: 42, streaming: true, references: [{ audio: 'x' }],
        });
        assert.deepEqual(body, {
            text: 'Hi', reference_id: VOICE, format: 'mp3', latency: 'balanced', mp3_bitrate: 192,
            temperature: 0.5, top_p: 0.9, normalize: false, chunk_length: 200,
            prosody: { speed: 1.25, normalize_loudness: true },
        });
    });

    it('range-checks numbers', () => {
        const bad = [
            { temperature: 1.5 }, { top_p: -0.1 }, { chunk_length: 50 }, { chunk_length: 150.5 },
            { prosody: { speed: 3 } }, { latency: 'fast' }, { mp3_bitrate: 96 }, { normalize: 'yes' },
            { temperature: Number.NaN }, { prosody: [] },
        ];
        for (const extra of bad) {
            assert.throws(() => buildTtsRequest({ text: 'Hi', reference_id: VOICE, ...extra }), RequestError, JSON.stringify(extra));
        }
    });

    it('accepts a list of voices for multi-speaker and rejects bad IDs', () => {
        const { body } = buildTtsRequest({ text: '<|speaker:0|>A<|speaker:1|>B', reference_id: [VOICE, VOICE2] });
        assert.deepEqual(body.reference_id, [VOICE, VOICE2]);
        for (const reference_id of [undefined, '', [], ['../etc'], 'a b', 'x'.repeat(65), Array(17).fill(VOICE)]) {
            assert.throws(() => buildTtsRequest({ text: 'Hi', reference_id }), RequestError);
        }
    });

    it('requires non-empty text within the limit', () => {
        assert.throws(() => buildTtsRequest({ text: '   ', reference_id: VOICE }), RequestError);
        assert.throws(() => buildTtsRequest({ text: 'x'.repeat(20001), reference_id: VOICE }), RequestError);
        assert.throws(() => buildTtsRequest(null), RequestError);
        assert.throws(() => buildTtsRequest([]), RequestError);
    });
});

describe('buildVoiceQuery', () => {
    it('clamps paging and passes only known filters', () => {
        const q = buildVoiceQuery({ page_size: '500', page_number: '-3', title: '  narrator ', language: 'en',
            sort_by: 'task_count', self: 'true', tag: ['male', '', 'deep'], author_id: 'x', evil: '1' });
        assert.equal(q.toString(), 'page_size=100&page_number=1&title=narrator&language=en&sort_by=task_count&self=true&tag=male&tag=deep');
    });

    it('ignores malformed values', () => {
        const q = buildVoiceQuery({ language: 'english; drop', sort_by: 'random', self: '1', page_size: 'abc' });
        assert.equal(q.toString(), 'page_size=20&page_number=1');
    });
});

describe('mapVoice', () => {
    it('makes cover URLs absolute and picks the first playable sample', () => {
        const v = mapVoice({
            _id: VOICE, title: 'Sheila', cover_image: 'coverimage/abc', languages: ['en'], tags: ['female'],
            author: { nickname: 'someone' }, like_count: 5, task_count: 9,
            samples: [{ title: 'no audio' }, { audio: 'https://platform.r2.fish.audio/task/1.mp3' }],
        });
        assert.equal(v.id, VOICE);
        assert.equal(v.cover, 'https://public-platform.r2.fish.audio/coverimage/abc');
        assert.equal(v.sample, 'https://platform.r2.fish.audio/task/1.mp3');
        assert.equal(v.author, 'someone');
    });

    it('survives missing fields', () => {
        const v = mapVoice({});
        assert.equal(v.cover, null);
        assert.equal(v.sample, null);
        assert.deepEqual(v.tags, []);
    });
});

describe('JobStore', () => {
    it('replays buffered chunks, follows live ones and merges on finish', () => {
        const store = new JobStore();
        const job = store.create('alice');
        store.push(job, Buffer.from('ab'));
        const seen = [];
        job.listeners.add((event, chunk) => seen.push(event === 'data' ? chunk.toString() : 'END'));
        store.push(job, Buffer.from('cd'));
        store.finish(job);
        store.push(job, Buffer.from('late'));
        assert.deepEqual(seen, ['cd', 'END']);
        assert.equal(job.chunks.length, 1);
        assert.equal(job.chunks[0].toString(), 'abcd');
    });

    it('only hands a job to its owner', () => {
        const store = new JobStore();
        const job = store.create('alice');
        assert.equal(store.get(job.id, 'alice'), job);
        assert.equal(store.get(job.id, 'bob'), null);
    });

    it('expires finished jobs after the TTL and stuck ones after the max age', () => {
        let now = 0;
        const store = new JobStore({ ttlMs: 100, maxAgeMs: 1000, now: () => now });
        const finished = store.create('a');
        const stuck = store.create('a');
        store.finish(finished);
        now = 150;
        store.sweep();
        assert.equal(store.jobs.has(finished.id), false);
        assert.equal(store.jobs.has(stuck.id), true);
        now = 1500;
        store.sweep();
        assert.equal(store.jobs.has(stuck.id), false);
    });

    it('evicts the oldest finished jobs when over the byte cap', () => {
        let now = 0;
        const store = new JobStore({ maxBytes: 10, now: () => now });
        const a = store.create('u');
        store.push(a, Buffer.alloc(6));
        store.finish(a);
        now = 1;
        const b = store.create('u');
        store.push(b, Buffer.alloc(6));
        store.finish(b);
        assert.equal(store.jobs.has(a.id), false);
        assert.equal(store.jobs.has(b.id), true);
    });
});

describe('KeyedLimiter', () => {
    it('queues past the limit per key and releases in order', async () => {
        const limiter = new KeyedLimiter(2);
        const r1 = await limiter.acquire('k');
        const r2 = await limiter.acquire('k');
        const other = await limiter.acquire('other');
        let third = false;
        const p3 = limiter.acquire('k').then(r => { third = true; return r; });
        await Promise.resolve();
        assert.equal(third, false);
        r1();
        r1();
        const r3 = await p3;
        assert.equal(third, true);
        assert.equal(limiter.slots.get('k').active, 2);
        r2();
        r3();
        other();
        assert.equal(limiter.slots.size, 0);
    });

    it('drops an aborted waiter from the queue', async () => {
        const limiter = new KeyedLimiter(1);
        const r1 = await limiter.acquire('k');
        const controller = new AbortController();
        const waiting = limiter.acquire('k', controller.signal);
        controller.abort(new Error('gone'));
        await assert.rejects(waiting, /gone/);
        r1();
        assert.equal(limiter.slots.size, 0);
    });
});

describe('Fish client', () => {
    const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers });

    it('sends the model header and bearer key', async () => {
        let seen;
        const fetchImpl = async (url, init) => {
            seen = { url, init };
            return new Response('mp3', { status: 200, headers: { 'content-type': 'audio/mpeg' } });
        };
        const res = await startTts({ key: 'sk', model: 's2.1-pro-free', body: { text: 'Hi' }, fetchImpl });
        assert.equal(res.status, 200);
        assert.equal(seen.url, 'https://api.fish.audio/v1/tts');
        assert.equal(seen.init.headers.model, 's2.1-pro-free');
        assert.equal(seen.init.headers.Authorization, 'Bearer sk');
    });

    it('retries 429 then succeeds', async () => {
        let calls = 0;
        const fetchImpl = async () => (++calls < 3 ? json(429, { message: 'slow down' }) : new Response('mp3'));
        const res = await startTts({ key: 'k', model: 's1', body: {}, fetchImpl, backoffMs: [1, 1, 1] });
        assert.equal(res.ok, true);
        assert.equal(calls, 3);
    });

    it('gives up on 429 after the backoff list and explains why', async () => {
        const fetchImpl = async () => json(429, { message: 'too many' });
        await assert.rejects(startTts({ key: 'k', model: 's1', body: {}, fetchImpl, backoffMs: [1] }),
            (e) => e instanceof FishError && e.status === 429 && /busy/.test(e.message));
    });

    it('keeps Fish\'s own 402 message', async () => {
        const msg = 'Insufficient API credit. Please visit https://fish.audio/app/developers to add funds.';
        const error = await toFishError(json(402, { error: { message: msg } }));
        assert.equal(error.status, 402);
        assert.equal(error.message, msg);
        const bare = await toFishError(new Response('', { status: 402 }));
        assert.match(bare.message, /Not enough Fish API credit/);
    });

    it('maps 5xx to 502 and tolerates non-JSON bodies', async () => {
        const error = await toFishError(new Response('<html>oops</html>', { status: 503 }));
        assert.equal(error.status, 502);
        assert.match(error.message, /HTTP 503/);
    });
});
