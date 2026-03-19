import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

describe('transcription service', () => {
  let createTranscriber;

  beforeEach(async () => {
    const mod = await import('../src/services/transcription.js');
    createTranscriber = mod.createTranscriber;
  });

  it('sends audio as multipart POST', async () => {
    let capturedUrl, capturedOpts;
    const mockFetch = async (url, opts) => {
      capturedUrl = url;
      capturedOpts = opts;
      return {
        ok: true,
        status: 200,
        json: async () => ({ text: 'hello world' }),
      };
    };

    const transcribe = createTranscriber({ fetchFn: mockFetch });
    const audioBuffer = Buffer.from('fake-audio-data');
    await transcribe(audioBuffer, 'test.ogg');

    expect(capturedUrl).toBe('http://localhost:8765/transcribe');
    expect(capturedOpts.method).toBe('POST');
    // Body should be a FormData instance (duck-type check)
    expect(capturedOpts.body).toBeDefined();
    expect(typeof capturedOpts.body.append).toBe('function');
  });

  it('returns transcript text on 200', async () => {
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ text: 'some transcript' }),
    });

    const transcribe = createTranscriber({ fetchFn: mockFetch });
    const result = await transcribe(Buffer.from('audio'), 'test.ogg');
    expect(result).toBe('some transcript');
  });

  it('throws on HTTP error', async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    });

    const transcribe = createTranscriber({ fetchFn: mockFetch });
    await expect(transcribe(Buffer.from('audio'), 'test.ogg')).rejects.toThrow(
      /transcription.*failed.*500/i,
    );
  });

  it('throws on timeout', async () => {
    // Mock fetch that never resolves until aborted
    const mockFetch = async (url, opts) => {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          resolve({ ok: true, status: 200, json: async () => ({ text: 'late' }) });
        }, 60000);
        if (opts?.signal) {
          opts.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }
      });
    };

    const transcribe = createTranscriber({ fetchFn: mockFetch, timeoutMs: 50 });
    await expect(transcribe(Buffer.from('audio'), 'test.ogg')).rejects.toThrow(
      /timeout|abort/i,
    );
  });

  it('uses WHISPER_URL from env', async () => {
    const origEnv = process.env.WHISPER_URL;
    process.env.WHISPER_URL = 'http://custom-host:9999/transcribe';

    let capturedUrl;
    const mockFetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        status: 200,
        json: async () => ({ text: 'ok' }),
      };
    };

    try {
      const transcribe = createTranscriber({ fetchFn: mockFetch });
      await transcribe(Buffer.from('audio'), 'test.ogg');
      expect(capturedUrl).toBe('http://custom-host:9999/transcribe');
    } finally {
      if (origEnv === undefined) {
        delete process.env.WHISPER_URL;
      } else {
        process.env.WHISPER_URL = origEnv;
      }
    }
  });
});
