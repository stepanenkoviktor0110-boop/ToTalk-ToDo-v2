/**
 * Transcription service — HTTP client for faster-whisper.
 *
 * Uses constructor injection for fetchFn (same pattern as GigaChatProvider)
 * to enable clean unit testing without module mocking.
 */

const DEFAULT_WHISPER_URL = 'http://localhost:8765/transcribe';
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Create a transcribe function with injected dependencies.
 *
 * @param {object} opts
 * @param {Function} [opts.fetchFn] - fetch implementation (injected for tests)
 * @param {number}   [opts.timeoutMs] - request timeout (default 20000)
 * @returns {Function} transcribe(audioBuffer, filename) => Promise<string>
 */
export function createTranscriber(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Lazy-load node-fetch if no fetchFn injected
  let fetchFn = opts.fetchFn ?? null;
  let fetchPromise = null;
  if (!fetchFn) {
    fetchPromise = import('node-fetch').then((m) => m.default);
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

    // Resolve fetch function
    const doFetch = fetchFn ?? (fetchFn = await fetchPromise);

    // Import FormData and Blob from node-fetch (or use injected fetch's globals)
    const { FormData, Blob } = await import('node-fetch');

    const form = new FormData();
    const blob = new Blob([audioBuffer]);
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
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        throw new Error(`Transcription timeout after ${timeoutMs / 1000}s`);
      }
      throw new Error(`Transcription request failed: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new Error(
        `Transcription failed with status ${response.status}`,
      );
    }

    const data = await response.json();
    return data.text;
  }

  return transcribe;
}
