/**
 * Transcription service — HTTP client for faster-whisper.
 *
 * Uses constructor injection for fetchFn (same pattern as GigaChatProvider)
 * to enable clean unit testing without module mocking.
 */

const DEFAULT_WHISPER_URL = 'http://localhost:8765/transcribe';
const DEFAULT_TIMEOUT_MS = 20_000;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Create a transcribe function with injected dependencies.
 *
 * @param {object} opts
 * @param {Function} [opts.fetchFn] - fetch implementation (injected for tests)
 * @param {Function} [opts.FormData] - FormData constructor (injected for tests)
 * @param {Function} [opts.Blob] - Blob constructor (injected for tests)
 * @param {number}   [opts.timeoutMs] - request timeout (default 20000)
 * @returns {Function} transcribe(audioBuffer, filename) => Promise<string>
 */
export function createTranscriber(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // When fetchFn is injected (testing), use it directly; otherwise lazy-load node-fetch
  const injectedFetchFn = opts.fetchFn ?? null;
  const injectedFormData = opts.FormData ?? null;
  const injectedBlob = opts.Blob ?? null;

  let nodeFetchModule = null;
  let nodeFetchPromise = null;
  if (!injectedFetchFn) {
    nodeFetchPromise = import('node-fetch').then((m) => {
      nodeFetchModule = m;
      return m.default;
    });
  }

  /**
   * Transcribe an audio buffer via faster-whisper HTTP API.
   *
   * @param {Buffer} audioBuffer - raw audio data
   * @param {string} filename - filename for the multipart form field
   * @returns {Promise<string>} transcript text
   */
  async function transcribe(audioBuffer, filename) {
    const url = process.env.WHISPER_URL ?? DEFAULT_WHISPER_URL;

    // SSRF protection: validate URL is loopback (Decision: security)
    try {
      const parsed = new URL(url);
      if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
        throw new Error(`WHISPER_URL must be a loopback address, got: ${parsed.hostname}`);
      }
    } catch (err) {
      if (err.message.startsWith('WHISPER_URL must be')) throw err;
      throw new Error(`WHISPER_URL is not a valid URL: ${url}`);
    }

    // Resolve fetch, FormData, Blob — from injection or node-fetch
    let doFetch, FD, BlobImpl;
    if (injectedFetchFn) {
      doFetch = injectedFetchFn;
      // Use injected FormData/Blob, or fall back to global (Node 18+ has global FormData/Blob)
      FD = injectedFormData ?? globalThis.FormData;
      BlobImpl = injectedBlob ?? globalThis.Blob;
    } else {
      doFetch = await nodeFetchPromise;
      FD = nodeFetchModule.FormData;
      BlobImpl = nodeFetchModule.Blob;
    }

    const form = new FD();
    const blob = new BlobImpl([audioBuffer]);
    form.append('file', blob, filename);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    try {
      response = await doFetch(url, {
        method: 'POST',
        body: form,
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        const error = new Error(`Transcription timeout after ${timeoutMs / 1000}s`);
        console.error(`[${new Date().toISOString()}] transcription error: ${error.message}`);
        throw error;
      }
      // Sanitize: use err.name only, not err.message which may contain URLs/credentials
      const error = new Error(`Transcription request failed: network error (${err.name})`);
      console.error(`[${new Date().toISOString()}] transcription error: ${error.message}`);
      throw error;
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const error = new Error(
        `Transcription failed with status ${response.status}`,
      );
      console.error(`[${new Date().toISOString()}] transcription error: ${error.message}`);
      throw error;
    }

    // Parse JSON response with validation
    let data;
    try {
      data = await response.json();
    } catch {
      const error = new Error('Transcription response is not valid JSON');
      console.error(`[${new Date().toISOString()}] transcription error: ${error.message}`);
      throw error;
    }

    if (typeof data.text !== 'string') {
      const error = new Error('Transcription response missing text field');
      console.error(`[${new Date().toISOString()}] transcription error: ${error.message}`);
      throw error;
    }

    return data.text;
  }

  return transcribe;
}
