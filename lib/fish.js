// Thin client for Fish Audio's documented REST API.

export const FISH_BASE = 'https://api.fish.audio';

export class FishError extends Error {
    /**
     * @param {number} status HTTP status to pass on
     * @param {string} message Message safe to show the user
     * @param {string} [code] Fish's error code header, when present
     */
    constructor(status, message, code) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

const HINTS = {
    401: 'Fish rejected the API key. Check it in the Fish Audio TTS settings.',
    402: 'Not enough Fish API credit for this model. API credit is separate from fish.audio app credit.',
    403: 'Fish refused access to this voice. It may be private.',
    404: 'Fish could not find that voice.',
    429: 'Fish is busy: too many requests at once. Try again shortly.',
};

/**
 * Reads a failed Fish response into a FishError with a readable message.
 * @param {Response} response
 */
export async function toFishError(response) {
    const code = response.headers.get('x-fish-error-code') ?? undefined;
    let detail = '';
    try {
        const text = await response.text();
        try {
            const json = JSON.parse(text);
            const raw = json?.message ?? json?.error?.message ?? json?.detail;
            detail = typeof raw === 'string' ? raw : raw ? JSON.stringify(raw) : '';
        } catch {
            detail = text;
        }
    } catch {
        // body unreadable, the status alone has to do
    }
    detail = detail.replace(/\s+/g, ' ').trim().slice(0, 300);
    const hint = HINTS[response.status] ?? `Fish returned HTTP ${response.status}.`;
    // Fish's own 402 text already explains the two credit wallets and links the top-up page.
    const message = response.status === 402 && detail ? detail
        : detail && !hint.includes(detail) ? `${hint} (${detail})` : hint;
    // 5xx from Fish becomes 502 here: the bridge worked, the upstream did not.
    const status = response.status >= 500 ? 502 : response.status;
    return new FishError(status, message, code);
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error('aborted'));
    }, { once: true });
});

/**
 * Starts a TTS request. Resolves once Fish answers with headers, so the
 * caller can stream the body. 429 is retried with backoff.
 * @param {object} options
 * @param {string} options.key Fish API key
 * @param {string} options.model Already validated model id
 * @param {Record<string, unknown>} options.body Already validated request body
 * @param {AbortSignal} [options.signal]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number[]} [options.backoffMs] Waits before each 429 retry
 * @returns {Promise<Response>} An ok response with an audio body
 */
export async function startTts({ key, model, body, signal, fetchImpl = fetch, backoffMs = [1000, 2000, 4000] }) {
    for (let attempt = 0; ; attempt++) {
        const response = await fetchImpl(`${FISH_BASE}/v1/tts`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${key}`,
                'Content-Type': 'application/json',
                'model': model,
            },
            body: JSON.stringify(body),
            signal,
        });
        if (response.ok) return response;
        if (response.status === 429 && attempt < backoffMs.length) {
            await response.body?.cancel().catch(() => {});
            await sleep(backoffMs[attempt], signal);
            continue;
        }
        throw await toFishError(response);
    }
}

/**
 * GETs a Fish JSON endpoint.
 * @param {string} path Path with query string, starting with /
 * @param {object} options
 * @param {string} [options.key] Fish API key, optional for public endpoints
 * @param {AbortSignal} [options.signal]
 * @param {typeof fetch} [options.fetchImpl]
 */
export async function getJson(path, { key, signal, fetchImpl = fetch } = {}) {
    const headers = key ? { 'Authorization': `Bearer ${key}` } : {};
    const response = await fetchImpl(`${FISH_BASE}${path}`, { headers, signal });
    if (!response.ok) throw await toFishError(response);
    return response.json();
}

/**
 * POSTs to a Fish endpoint and parses the JSON answer.
 * @param {string} path
 * @param {object} options
 * @param {string} options.key Fish API key
 * @param {BodyInit} options.body JSON string or FormData
 * @param {Record<string, string>} [options.headers]
 * @param {AbortSignal} [options.signal]
 * @param {typeof fetch} [options.fetchImpl]
 */
export async function postFish(path, { key, body, headers = {}, signal, fetchImpl = fetch }) {
    const response = await fetchImpl(`${FISH_BASE}${path}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, ...headers },
        body,
        signal,
    });
    if (!response.ok) throw await toFishError(response);
    return response.json();
}
