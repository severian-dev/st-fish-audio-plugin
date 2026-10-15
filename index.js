// Fish Audio bridge, a SillyTavern server plugin.
// Browsers can't call Fish's TTS endpoint (no CORS headers), so the Fish Audio
// TTS extension talks to these routes instead. The API key stays on the server
// in SillyTavern's secrets store.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { AudioCache } from './lib/cache.js';
import { randomUUID } from 'node:crypto';

import { FishError, getJson, postFish, startTts } from './lib/fish.js';
import { JobStore } from './lib/jobs.js';
import { KeyedLimiter } from './lib/limiter.js';
import { buildDesignRequest, buildTtsRequest, buildVoiceQuery, DEFAULT_MODEL, isVoiceId, mapVoice, MODELS, RequestError } from './lib/validate.js';

const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const TAG = '[fish-audio]';

/** Same secret name as the core Fish Audio provider proposal, so a saved key works for both. */
export const SECRET_KEY = 'api_key_fish_audio';
const CONCURRENCY = 5;
const HEADER_TIMEOUT_MS = 60_000;
const IDLE_TIMEOUT_MS = 60_000;
const JSON_TIMEOUT_MS = 20_000;

export const info = {
    id: 'fish-audio',
    name: 'Fish Audio',
    description: 'Connects the Fish Audio TTS extension to Fish Audio\'s API. Keeps the API key on the server and streams audio.',
};

const jobs = new JobStore();
const limiter = new KeyedLimiter(CONCURRENCY);
/** @type {AudioCache} */
let cache;
/** Jobs still generating, by owner and cache key, so identical requests share one Fish call. */
const pending = new Map();
/**
 * Voice design results waiting for the user to pick one, kept server side so
 * the audio never has to travel back up from the browser.
 * @type {Map<string, {owner: string, at: number, candidates: {index: number, wav: Buffer, signature: string, text: string}[]}>}
 */
const designs = new Map();
const DESIGN_TTL_MS = 30 * 60_000;
const DESIGN_MODEL = 'voice-design-1';
const SAVE_TIMEOUT_MS = 180_000;
/** @type {Set<AbortController>} */
const inFlight = new Set();
/** @type {NodeJS.Timeout|undefined} */
let sweepTimer;
/** @type {(directories: any, key: string) => string} */
let readSecret;

/**
 * Finds SillyTavern's secrets module. The server chdirs to its own root at
 * startup, so cwd is tried first. That also works when the plugin folder is a
 * symlink, where a path relative to this file would point outside SillyTavern.
 */
async function loadReadSecret() {
    const candidates = [
        path.join(process.cwd(), 'src', 'endpoints', 'secrets.js'),
        fileURLToPath(new URL('../../src/endpoints/secrets.js', import.meta.url)),
    ];
    for (const file of candidates) {
        if (!fs.existsSync(file)) continue;
        const mod = await import(pathToFileURL(file).href);
        if (typeof mod.readSecret === 'function') return mod.readSecret;
    }
    throw new Error('could not find SillyTavern\'s secrets module (src/endpoints/secrets.js)');
}

const keyFor = (req) => readSecret(req.user.directories, SECRET_KEY) || '';
const ownerOf = (req) => String(req.user?.profile?.handle ?? 'default-user');

function sendError(res, error) {
    if (error instanceof RequestError || error instanceof FishError) {
        return res.status(error.status).json({ error: error.message, code: error.code });
    }
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        return res.status(504).json({ error: 'Fish did not answer in time. Try again.' });
    }
    console.error(TAG, error);
    return res.status(500).json({ error: 'Fish Audio plugin error. Check the SillyTavern server console.' });
}

/**
 * Copies Fish's audio body into the job, then frees the concurrency slot.
 * @param {import('./lib/jobs.js').Job} job
 * @param {Response} response
 * @param {AbortController} controller
 * @param {() => void} release
 * @param {(job: import('./lib/jobs.js').Job) => void} onDone Runs after the job finishes, ok or not
 */
async function pump(job, response, controller, release, onDone) {
    /** @type {NodeJS.Timeout|undefined} */
    let idle;
    const arm = () => {
        clearTimeout(idle);
        idle = setTimeout(() => controller.abort(new DOMException('stream stalled', 'TimeoutError')), IDLE_TIMEOUT_MS);
    };
    try {
        arm();
        // @ts-ignore Node's web stream is async iterable
        for await (const chunk of response.body) {
            jobs.push(job, Buffer.from(chunk));
            arm();
        }
        jobs.finish(job);
    } catch (error) {
        console.warn(TAG, 'audio stream from Fish was interrupted:', error?.message ?? error);
        jobs.finish(job, 'Audio stream from Fish was interrupted.');
    } finally {
        clearTimeout(idle);
        release();
        inFlight.delete(controller);
        onDone(job);
    }
}

/**
 * Sends a finished job, honoring a single byte range (media elements ask for one).
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {Buffer} buffer
 */
function sendBuffer(req, res, buffer) {
    res.setHeader('Accept-Ranges', 'bytes');
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (!match || (!match[1] && !match[2])) {
        res.setHeader('Content-Length', buffer.length);
        return res.status(200).end(buffer);
    }
    let start = match[1] ? Number(match[1]) : buffer.length - Number(match[2]);
    let end = match[1] && match[2] ? Number(match[2]) : buffer.length - 1;
    start = Math.max(0, start);
    end = Math.min(end, buffer.length - 1);
    if (start > end) {
        res.setHeader('Content-Range', `bytes */${buffer.length}`);
        return res.status(416).end();
    }
    res.setHeader('Content-Range', `bytes ${start}-${end}/${buffer.length}`);
    res.setHeader('Content-Length', end - start + 1);
    return res.status(206).end(buffer.subarray(start, end + 1));
}

/** @param {import('express').Router} router */
export async function init(router) {
    readSecret = await loadReadSecret();
    const dataRoot = globalThis.DATA_ROOT ?? path.join(process.cwd(), 'data');
    cache = new AudioCache({ root: path.join(dataRoot, '_cache', 'fish-audio') });
    sweepTimer = setInterval(() => {
        jobs.sweep();
        for (const [id, design] of designs) if (Date.now() - design.at > DESIGN_TTL_MS) designs.delete(id);
    }, 60_000);
    sweepTimer.unref();

    router.get('/status', (req, res) => {
        res.json({
            version: pkg.version,
            keySet: Boolean(keyFor(req)),
            models: MODELS,
            defaultModel: DEFAULT_MODEL,
            features: ['cache', 'design'],
        });
    });

    router.get('/cache', async (req, res) => {
        try {
            res.json(await cache.stats(ownerOf(req)));
        } catch (error) {
            sendError(res, error);
        }
    });

    router.delete('/cache', async (req, res) => {
        try {
            await cache.clear(ownerOf(req));
            res.json(await cache.stats(ownerOf(req)));
        } catch (error) {
            sendError(res, error);
        }
    });

    router.get('/voices', async (req, res) => {
        try {
            const params = buildVoiceQuery(req.query);
            const key = keyFor(req);
            if (params.get('self') === 'true' && !key) {
                throw new RequestError('Add your Fish API key to list your own voices.', 401);
            }
            const data = await getJson(`/model?${params}`, { key, signal: AbortSignal.timeout(JSON_TIMEOUT_MS) });
            res.json({
                total: Number(data?.total) || 0,
                hasMore: Boolean(data?.has_more),
                items: Array.isArray(data?.items) ? data.items.map(mapVoice) : [],
            });
        } catch (error) {
            sendError(res, error);
        }
    });

    router.get('/voices/:id', async (req, res) => {
        try {
            if (!isVoiceId(req.params.id)) throw new RequestError('That is not a Fish voice ID.');
            const data = await getJson(`/model/${req.params.id}`, { key: keyFor(req), signal: AbortSignal.timeout(JSON_TIMEOUT_MS) });
            res.json(mapVoice(data));
        } catch (error) {
            sendError(res, error);
        }
    });

    router.get('/credit', async (req, res) => {
        try {
            const key = keyFor(req);
            if (!key) throw new RequestError('No Fish API key set.', 401);
            const data = await getJson('/wallet/self/api-credit', { key, signal: AbortSignal.timeout(JSON_TIMEOUT_MS) });
            res.json({ credit: data?.credit ?? null });
        } catch (error) {
            sendError(res, error);
        }
    });

    // Voice design: describe a voice, get candidates to audition, save one as a
    // private voice on the user's Fish account. $0.01 per design request.
    router.post('/design', async (req, res) => {
        /** @type {(() => void)|null} */
        let release = null;
        try {
            const key = keyFor(req);
            if (!key) throw new RequestError('No Fish API key set. Add it in the Fish Audio TTS settings.', 401);
            const body = buildDesignRequest(req.body);
            release = await limiter.acquire(key);
            const data = await postFish('/v1/voice-design', {
                key,
                body: JSON.stringify(body),
                headers: { 'Content-Type': 'application/json', 'model': DESIGN_MODEL },
                signal: AbortSignal.timeout(HEADER_TIMEOUT_MS),
            });
            const candidates = (Array.isArray(data?.candidates) ? data.candidates : [])
                .filter(c => typeof c?.audio_base64 === 'string' && typeof c?.signature === 'string');
            if (!candidates.length) throw new FishError(502, 'Fish returned no voice candidates. Try a different description.');
            const id = randomUUID();
            designs.set(id, {
                owner: ownerOf(req),
                at: Date.now(),
                candidates: candidates.map((c, i) => ({
                    index: i,
                    wav: Buffer.from(c.audio_base64, 'base64'),
                    signature: c.signature,
                    text: String(c.text ?? body.reference_text ?? ''),
                })),
            });
            res.json({
                id,
                candidates: candidates.map((c, i) => ({
                    index: i,
                    durationMs: Number(c.duration_ms) || 0,
                    description: String(c.features?.description ?? ''),
                    traits: ['gender', 'age', 'accent', 'tone', 'pacing']
                        .map(k => c.features?.[k]).filter(v => typeof v === 'string' && v).map(String),
                })),
            });
        } catch (error) {
            sendError(res, error);
        } finally {
            release?.();
        }
    });

    /** @param {import('express').Request} req */
    function findCandidate(req) {
        const design = designs.get(req.params.id);
        const candidate = design && design.owner === ownerOf(req) ? design.candidates[Number(req.params.index)] : null;
        if (!candidate) throw new RequestError('That design has expired. Design the voice again.', 404);
        return candidate;
    }

    router.get('/design/:id/:index', (req, res) => {
        try {
            const candidate = findCandidate(req);
            res.setHeader('Content-Type', 'audio/wav');
            res.setHeader('Cache-Control', 'no-store');
            sendBuffer(req, res, candidate.wav);
        } catch (error) {
            sendError(res, error);
        }
    });

    // Saving creates a private voice on the user's Fish account. The candidate's
    // signature gets it marked as a designed voice. Fish takes about 15 seconds.
    router.post('/design/:id/:index/save', async (req, res) => {
        try {
            const key = keyFor(req);
            if (!key) throw new RequestError('No Fish API key set.', 401);
            const candidate = findCandidate(req);
            const title = typeof req.body?.title === 'string' ? req.body.title.trim().slice(0, 100) : '';
            if (!title) throw new RequestError('Give the voice a name');
            const form = new FormData();
            form.append('type', 'tts');
            form.append('title', title);
            form.append('train_mode', 'fast');
            form.append('visibility', 'private');
            form.append('voices', new Blob([candidate.wav], { type: 'audio/wav' }), 'voice.wav');
            if (candidate.text) form.append('texts', candidate.text);
            form.append('voice_design_signatures', candidate.signature);
            const data = await postFish('/model', { key, body: form, signal: AbortSignal.timeout(SAVE_TIMEOUT_MS) });
            res.status(201).json(mapVoice(data));
        } catch (error) {
            sendError(res, error);
        }
    });

    // Starts synthesis and answers once Fish has accepted the request, so bad
    // keys, missing credit and validation errors come back here, not as a
    // broken audio stream. Cached audio and identical requests already in
    // progress are reused unless the client sends `cache: false`.
    router.post('/tts', async (req, res) => {
        const controller = new AbortController();
        inFlight.add(controller);
        /** @type {(() => void)|null} */
        let release = null;
        let handedOff = false;
        try {
            const key = keyFor(req);
            if (!key) throw new RequestError('No Fish API key set. Add it in the Fish Audio TTS settings.', 401);
            const { model, body } = buildTtsRequest(req.body);
            const owner = ownerOf(req);
            const useCache = req.body?.cache !== false;
            const cacheKey = AudioCache.keyFor(model, body);
            const pendingKey = `${owner}:${cacheKey}`;

            if (useCache) {
                const shared = jobs.get(pending.get(pendingKey) ?? '', owner);
                if (shared && !shared.error) return res.json({ id: shared.id, cached: false });
                const hit = await cache.get(owner, cacheKey);
                if (hit) {
                    const job = jobs.create(owner);
                    jobs.push(job, hit);
                    jobs.finish(job);
                    return res.json({ id: job.id, cached: true });
                }
            }

            release = await limiter.acquire(key, controller.signal);

            const timer = setTimeout(() => controller.abort(new DOMException('no answer', 'TimeoutError')), HEADER_TIMEOUT_MS);
            let response;
            try {
                response = await startTts({ key, model, body, signal: controller.signal });
            } finally {
                clearTimeout(timer);
            }

            const job = jobs.create(owner);
            if (useCache) pending.set(pendingKey, job.id);
            handedOff = true;
            void pump(job, response, controller, release, (done) => {
                // Stay findable until the file is written, so a repeat in that window reuses this job.
                const forget = () => pending.get(pendingKey) === done.id && pending.delete(pendingKey);
                if (!useCache || done.error || !done.size) return void forget();
                cache.put(owner, cacheKey, done.chunks[0])
                    .catch((error) => console.warn(TAG, 'could not cache audio:', error.message))
                    .finally(forget);
            });
            res.json({ id: job.id, cached: false });
        } catch (error) {
            sendError(res, error);
        } finally {
            if (!handedOff) {
                release?.();
                inFlight.delete(controller);
            }
        }
    });

    // Streams a job's audio. Whatever has arrived is sent at once, then live
    // chunks follow until Fish finishes.
    router.get('/tts/:id', (req, res) => {
        const job = jobs.get(req.params.id, ownerOf(req));
        if (!job) {
            // SillyTavern's TTS queue only advances on the audio element's
            // `ended` event. An error would stall it, so answer with silence.
            console.warn(TAG, 'audio job not found or expired:', req.params.id);
            return res.redirect(307, '/sounds/silence.mp3');
        }
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Cache-Control', 'no-store');
        if (job.done) {
            if (job.size === 0) return res.redirect(307, '/sounds/silence.mp3');
            return sendBuffer(req, res, job.chunks[0]);
        }
        res.status(200);
        for (const chunk of job.chunks) res.write(chunk);
        /** @param {'data'|'end'} event @param {Buffer} [chunk] */
        const listener = (event, chunk) => (event === 'data' ? res.write(chunk) : res.end());
        job.listeners.add(listener);
        req.on('close', () => job.listeners.delete(listener));
    });

    console.log(TAG, `loaded v${pkg.version}`);
}

export async function exit() {
    clearInterval(sweepTimer);
    designs.clear();
    for (const controller of inFlight) controller.abort();
    jobs.clear();
}
