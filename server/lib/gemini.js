/**
 * Gemini API client (Google AI) over REST, with:
 *  - structured JSON output enforced by `responseSchema`
 *  - exponential backoff + jitter on 429 / 5xx / network errors (honours Retry-After)
 *  - hard request timeout
 */
import { HttpError } from './errors.js';

export class AiUnavailableError extends HttpError {
  constructor(message = 'The AI assistant is busy right now. Please try again in a minute.') {
    super(503, message);
    this.name = 'AiUnavailableError';
  }
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createGeminiClient({
  apiKey,
  model = 'gemini-2.5-flash',
  fetchImpl = fetch,
  maxRetries = 3,
  baseDelayMs = 600,
  timeoutMs = 25_000,
  sleep = realSleep,
  logger,
} = {}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  /**
   * @param {{system: string, parts: object[], schema: object, temperature?: number}} req
   * @returns {Promise<any>} parsed JSON matching `schema`
   */
  async function generateJson({ system, parts, schema, temperature = 0.3 }) {
    if (!apiKey) throw new AiUnavailableError('AI features are not configured on this server.');
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts }],
      generationConfig: { temperature, responseMimeType: 'application/json', responseSchema: schema },
    });

    for (let attempt = 0; ; attempt += 1) {
      let res;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        if (attempt >= maxRetries) throw new AiUnavailableError();
        logger?.warn('gemini network error, retrying', { attempt, error: err.message });
        await sleep(backoff(attempt));
        continue;
      }

      if (res.ok) {
        const json = await res.json();
        const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
        try {
          return JSON.parse(text);
        } catch {
          throw new AiUnavailableError('The AI returned an unreadable answer. Please try again.');
        }
      }

      if (!RETRYABLE.has(res.status) || attempt >= maxRetries) {
        logger?.error('gemini request failed', { status: res.status });
        throw new AiUnavailableError();
      }
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
    }
  }

  const backoff = (attempt) => baseDelayMs * 2 ** attempt + Math.floor(Math.random() * baseDelayMs);

  return { available: Boolean(apiKey), model, generateJson };
}
