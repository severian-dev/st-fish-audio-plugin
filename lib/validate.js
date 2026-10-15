// Request validation for the Fish Audio bridge.
// Fish bills a missing or unknown `model` header as the paid s2.1-pro, so the
// model is checked against a fixed list and nothing else is ever forwarded.

export const MODELS = Object.freeze(['s2.1-pro-free', 's2.1-pro', 's2-pro', 's1', 'drama-3']);
export const DEFAULT_MODEL = 's2.1-pro-free';
export const MAX_TEXT_LENGTH = 20000;
export const MAX_SPEAKERS = 16;

const VOICE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const LATENCIES = ['low', 'normal', 'balanced'];
const MP3_BITRATES = [64, 128, 192];

export class RequestError extends Error {
    /**
     * @param {string} message Message safe to show the user
     * @param {number} [status] HTTP status to answer with
     */
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

/** @param {unknown} id */
export function isVoiceId(id) {
    return typeof id === 'string' && VOICE_ID_RE.test(id);
}

function number(value, field, min, max) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
        throw new RequestError(`${field} must be a number from ${min} to ${max}`);
    }
    return value;
}

function boolean(value, field) {
    if (typeof value !== 'boolean') {
        throw new RequestError(`${field} must be true or false`);
    }
    return value;
}

function oneOf(value, field, allowed) {
    if (!allowed.includes(value)) {
        throw new RequestError(`${field} must be one of: ${allowed.join(', ')}`);
    }
    return value;
}

/**
 * Builds the Fish `POST /v1/tts` body from an untrusted client payload.
 * Only known fields pass, each type and range checked. Output is always MP3,
 * the one format every browser can stream into an audio element.
 * @param {unknown} input Client payload
 * @returns {{model: string, body: Record<string, unknown>}}
 */
export function buildTtsRequest(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new RequestError('Request body must be a JSON object');
    }
    const src = /** @type {Record<string, any>} */ (input);

    const model = src.model === undefined ? DEFAULT_MODEL : src.model;
    oneOf(model, 'model', MODELS);

    if (typeof src.text !== 'string' || !src.text.trim()) {
        throw new RequestError('text must be a non-empty string');
    }
    if (src.text.length > MAX_TEXT_LENGTH) {
        throw new RequestError(`text is longer than ${MAX_TEXT_LENGTH} characters`);
    }

    const ref = src.reference_id;
    if (Array.isArray(ref)) {
        if (ref.length === 0 || ref.length > MAX_SPEAKERS || !ref.every(isVoiceId)) {
            throw new RequestError(`reference_id must be a voice ID or a list of 1 to ${MAX_SPEAKERS} voice IDs`);
        }
    } else if (!isVoiceId(ref)) {
        throw new RequestError('reference_id must be a voice ID');
    }

    /** @type {Record<string, unknown>} */
    const body = { text: src.text, reference_id: ref, format: 'mp3' };

    if (src.latency !== undefined) body.latency = oneOf(src.latency, 'latency', LATENCIES);
    if (src.mp3_bitrate !== undefined) body.mp3_bitrate = oneOf(src.mp3_bitrate, 'mp3_bitrate', MP3_BITRATES);
    if (src.temperature !== undefined) body.temperature = number(src.temperature, 'temperature', 0, 1);
    if (src.top_p !== undefined) body.top_p = number(src.top_p, 'top_p', 0, 1);
    if (src.normalize !== undefined) body.normalize = boolean(src.normalize, 'normalize');
    if (src.chunk_length !== undefined) {
        if (!Number.isInteger(src.chunk_length)) throw new RequestError('chunk_length must be a whole number');
        body.chunk_length = number(src.chunk_length, 'chunk_length', 100, 300);
    }

    if (src.prosody !== undefined) {
        if (!src.prosody || typeof src.prosody !== 'object' || Array.isArray(src.prosody)) {
            throw new RequestError('prosody must be an object');
        }
        const prosody = {};
        if (src.prosody.speed !== undefined) prosody.speed = number(src.prosody.speed, 'prosody.speed', 0.5, 2);
        if (src.prosody.normalize_loudness !== undefined) {
            prosody.normalize_loudness = boolean(src.prosody.normalize_loudness, 'prosody.normalize_loudness');
        }
        if (Object.keys(prosody).length) body.prosody = prosody;
    }

    return { model, body };
}

const LANGUAGE_RE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;

/**
 * Builds the Fish `POST /v1/voice-design` body from an untrusted client payload.
 * @param {unknown} input
 */
export function buildDesignRequest(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new RequestError('Request body must be a JSON object');
    }
    const src = /** @type {Record<string, any>} */ (input);
    const instruction = typeof src.instruction === 'string' ? src.instruction.trim() : '';
    if (!instruction || instruction.length > 2000) {
        throw new RequestError('Describe the voice in 1 to 2000 characters');
    }
    /** @type {Record<string, unknown>} */
    const body = { instruction };
    if (src.reference_text !== undefined && src.reference_text !== null && String(src.reference_text).trim()) {
        const text = String(src.reference_text).trim();
        if (text.length > 150) throw new RequestError('The preview line must be 150 characters or fewer');
        body.reference_text = text;
    }
    if (src.language) {
        if (!LANGUAGE_RE.test(String(src.language))) throw new RequestError('language must be a code like en or ja');
        body.language = String(src.language);
    }
    const n = src.n === undefined ? 3 : src.n;
    if (!Number.isInteger(n) || n < 1 || n > 4) throw new RequestError('n must be 1 to 4');
    body.n = n;
    return body;
}

const SORTS = ['score', 'task_count', 'created_at'];

/**
 * Builds the query string for Fish `GET /model` from untrusted client params.
 * @param {Record<string, unknown>} query Express query object
 * @returns {URLSearchParams}
 */
export function buildVoiceQuery(query) {
    const params = new URLSearchParams();
    const str = (v) => (typeof v === 'string' ? v.trim() : '');

    const pageSize = Number(query.page_size ?? 20);
    params.set('page_size', String(Number.isInteger(pageSize) ? Math.min(Math.max(pageSize, 1), 100) : 20));
    const page = Number(query.page_number ?? 1);
    params.set('page_number', String(Number.isInteger(page) && page >= 1 ? Math.min(page, 1000) : 1));

    const title = str(query.title).slice(0, 100);
    if (title) params.set('title', title);
    const language = str(query.language);
    if (LANGUAGE_RE.test(language)) params.set('language', language);
    const sort = str(query.sort_by);
    if (SORTS.includes(sort)) params.set('sort_by', sort);
    if (query.self === 'true') params.set('self', 'true');

    const tags = Array.isArray(query.tag) ? query.tag : [query.tag];
    for (const tag of tags.map(str).filter(Boolean).slice(0, 5)) {
        params.append('tag', tag.slice(0, 40));
    }
    return params;
}

const COVER_BASE = 'https://public-platform.r2.fish.audio/';

/**
 * Trims a Fish voice model to the fields the extension uses.
 * @param {any} item Item from Fish `GET /model` or `GET /model/{id}`
 */
export function mapVoice(item) {
    const cover = typeof item?.cover_image === 'string' && item.cover_image
        ? (item.cover_image.startsWith('http') ? item.cover_image : COVER_BASE + item.cover_image)
        : null;
    const samples = Array.isArray(item?.samples) ? item.samples : [];
    return {
        id: String(item?._id ?? ''),
        title: String(item?.title ?? ''),
        description: String(item?.description ?? ''),
        cover,
        languages: Array.isArray(item?.languages) ? item.languages.map(String) : [],
        tags: Array.isArray(item?.tags) ? item.tags.map(String) : [],
        author: String(item?.author?.nickname ?? ''),
        likes: Number(item?.like_count) || 0,
        uses: Number(item?.task_count) || 0,
        visibility: String(item?.visibility ?? ''),
        state: String(item?.state ?? ''),
        sample: samples.find(s => typeof s?.audio === 'string')?.audio ?? null,
    };
}
