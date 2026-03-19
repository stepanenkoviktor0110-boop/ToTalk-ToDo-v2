import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// We use constructor injection for fetch to avoid unstable ESM module mocking.
// GigaChatProvider accepts { fetchFn, authKey, model, certPath } in constructor.

// Helper: build a mock fetch that returns preset responses based on URL
function createMockFetch(handlers) {
  return async (url, opts) => {
    for (const h of handlers) {
      if (url.includes(h.match)) {
        if (h.delay) {
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, h.delay);
            if (opts?.signal) {
              opts.signal.addEventListener('abort', () => {
                clearTimeout(timer);
                resolve();
              });
            }
          });
          if (opts?.signal?.aborted) {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            err.type = 'aborted';
            throw err;
          }
        }
        if (h.networkError) {
          throw h.networkError;
        }
        return {
          ok: h.status >= 200 && h.status < 300,
          status: h.status,
          statusText: h.statusText || 'OK',
          json: async () => h.body,
          text: async () => JSON.stringify(h.body),
        };
      }
    }
    throw new Error(`Unhandled fetch URL: ${url}`);
  };
}

// Helper: create a token response
function tokenResponse(expiresInMs = 600000) {
  return {
    access_token: 'test-access-token-abc123',
    expires_at: Date.now() + expiresInMs,
  };
}

// Helper: create a chat completion response
function completionResponse(content = 'Task 1: Call Ivan') {
  return {
    choices: [{ message: { content } }],
  };
}

describe('LLMProvider base class', () => {
  it('throws "not implemented" when complete() is called directly', async () => {
    // Dynamic import to allow the file to not exist yet (TDD)
    const { LLMProvider } = await import('../src/services/llm/provider.js');
    const provider = new LLMProvider();
    await expect(provider.complete('system', 'user')).rejects.toThrow(
      'not implemented',
    );
  });
});

describe('GigaChatProvider', () => {
  let GigaChatProvider;

  beforeEach(async () => {
    const mod = await import('../src/services/llm/gigachat.js');
    GigaChatProvider = mod.GigaChatProvider;
  });

  it('complete() extracts content from response', async () => {
    const mockFetch = createMockFetch([
      { match: 'oauth', status: 200, body: tokenResponse() },
      {
        match: 'chat/completions',
        status: 200,
        body: completionResponse('1. Buy milk\n2. Call dentist'),
      },
    ]);

    const provider = new GigaChatProvider({
      fetchFn: mockFetch,
      authKey: 'dGVzdC1rZXk=',
      model: 'GigaChat-2',
      certPath: null, // skip cert loading in tests
    });

    const result = await provider.complete('You are helpful.', 'Buy milk and call dentist');
    expect(typeof result).toBe('string');
    expect(result).toBe('1. Buy milk\n2. Call dentist');
  });

  it('refreshes token when <60s to expiry', async () => {
    const calls = [];
    const mockFetch = async (url, opts) => {
      calls.push(url);
      if (url.includes('oauth')) {
        return {
          ok: true,
          status: 200,
          json: async () => tokenResponse(600000),
          text: async () => JSON.stringify(tokenResponse(600000)),
        };
      }
      if (url.includes('chat/completions')) {
        return {
          ok: true,
          status: 200,
          json: async () => completionResponse('done'),
          text: async () => JSON.stringify(completionResponse('done')),
        };
      }
      throw new Error(`Unhandled: ${url}`);
    };

    const provider = new GigaChatProvider({
      fetchFn: mockFetch,
      authKey: 'dGVzdC1rZXk=',
      model: 'GigaChat-2',
      certPath: null,
    });

    // First call: token fetched + completion
    await provider.complete('sys', 'msg');
    expect(calls.filter((u) => u.includes('oauth')).length).toBe(1);

    // Manually set token to expire in 30 seconds (< 60s threshold)
    provider._expiresAt = Date.now() + 30000;
    calls.length = 0;

    // Second call: should re-fetch token
    await provider.complete('sys', 'msg2');
    expect(calls.filter((u) => u.includes('oauth')).length).toBe(1);
  });

  it('retries once on 401', async () => {
    let completionCallCount = 0;
    const mockFetch = async (url, opts) => {
      if (url.includes('oauth')) {
        return {
          ok: true,
          status: 200,
          json: async () => tokenResponse(),
          text: async () => JSON.stringify(tokenResponse()),
        };
      }
      if (url.includes('chat/completions')) {
        completionCallCount++;
        if (completionCallCount === 1) {
          return {
            ok: false,
            status: 401,
            statusText: 'Unauthorized',
            json: async () => ({ error: 'unauthorized' }),
            text: async () => '{"error":"unauthorized"}',
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => completionResponse('retried OK'),
          text: async () => JSON.stringify(completionResponse('retried OK')),
        };
      }
      throw new Error(`Unhandled: ${url}`);
    };

    const provider = new GigaChatProvider({
      fetchFn: mockFetch,
      authKey: 'dGVzdC1rZXk=',
      model: 'GigaChat-2',
      certPath: null,
    });

    const result = await provider.complete('sys', 'msg');
    expect(result).toBe('retried OK');
    expect(completionCallCount).toBe(2);
  });

  it('retries once on 5xx and throws on second failure', async () => {
    let completionCallCount = 0;
    const mockFetch = async (url, opts) => {
      if (url.includes('oauth')) {
        return {
          ok: true,
          status: 200,
          json: async () => tokenResponse(),
          text: async () => JSON.stringify(tokenResponse()),
        };
      }
      if (url.includes('chat/completions')) {
        completionCallCount++;
        return {
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          json: async () => ({ error: 'server error' }),
          text: async () => '{"error":"server error"}',
        };
      }
      throw new Error(`Unhandled: ${url}`);
    };

    const provider = new GigaChatProvider({
      fetchFn: mockFetch,
      authKey: 'dGVzdC1rZXk=',
      model: 'GigaChat-2',
      certPath: null,
    });

    await expect(provider.complete('sys', 'msg')).rejects.toThrow();
    expect(completionCallCount).toBe(2);
  });

  it('does not retry on 4xx (non-401)', async () => {
    let completionCallCount = 0;
    const mockFetch = async (url, opts) => {
      if (url.includes('oauth')) {
        return {
          ok: true,
          status: 200,
          json: async () => tokenResponse(),
          text: async () => JSON.stringify(tokenResponse()),
        };
      }
      if (url.includes('chat/completions')) {
        completionCallCount++;
        return {
          ok: false,
          status: 400,
          statusText: 'Bad Request',
          json: async () => ({ error: 'bad request' }),
          text: async () => '{"error":"bad request"}',
        };
      }
      throw new Error(`Unhandled: ${url}`);
    };

    const provider = new GigaChatProvider({
      fetchFn: mockFetch,
      authKey: 'dGVzdC1rZXk=',
      model: 'GigaChat-2',
      certPath: null,
    });

    await expect(provider.complete('sys', 'msg')).rejects.toThrow();
    expect(completionCallCount).toBe(1);
  });

  it('throws on timeout', async () => {
    // Mock a fetch that never resolves (simulates hanging request)
    const mockFetch = createMockFetch([
      { match: 'oauth', status: 200, body: tokenResponse() },
      {
        match: 'chat/completions',
        delay: 20000, // longer than 15s timeout
        status: 200,
        body: completionResponse('too slow'),
      },
    ]);

    const provider = new GigaChatProvider({
      fetchFn: mockFetch,
      authKey: 'dGVzdC1rZXk=',
      model: 'GigaChat-2',
      certPath: null,
      timeoutMs: 50, // Use short timeout for test speed
    });

    await expect(provider.complete('sys', 'msg')).rejects.toThrow(/abort|timed.out|timeout/i);
  });

  it('no credentials in error logs', async () => {
    const AUTH_KEY = 'super-secret-auth-key-12345';
    const ACCESS_TOKEN = 'secret-access-token-xyz789';
    const logs = [];

    // Capture console.error and console.log
    const origError = console.error;
    const origLog = console.log;
    const origWarn = console.warn;
    console.error = (...args) => logs.push(args.join(' '));
    console.log = (...args) => logs.push(args.join(' '));
    console.warn = (...args) => logs.push(args.join(' '));

    try {
      // Mock: token succeeds, completion fails with 500 twice (retry exhausted)
      let completionCalls = 0;
      const mockFetch = async (url, opts) => {
        if (url.includes('oauth')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              access_token: ACCESS_TOKEN,
              expires_at: Date.now() + 600000,
            }),
            text: async () =>
              JSON.stringify({
                access_token: ACCESS_TOKEN,
                expires_at: Date.now() + 600000,
              }),
          };
        }
        if (url.includes('chat/completions')) {
          completionCalls++;
          return {
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
            json: async () => ({ error: 'server error' }),
            text: async () => '{"error":"server error"}',
          };
        }
        throw new Error(`Unhandled: ${url}`);
      };

      const provider = new GigaChatProvider({
        fetchFn: mockFetch,
        authKey: AUTH_KEY,
        model: 'GigaChat-2',
        certPath: null,
      });

      try {
        await provider.complete('sys', 'msg');
      } catch {
        // Expected to throw
      }

      const allLogs = logs.join('\n');
      expect(allLogs).not.toContain(AUTH_KEY);
      expect(allLogs).not.toContain(ACCESS_TOKEN);
    } finally {
      console.error = origError;
      console.log = origLog;
      console.warn = origWarn;
    }
  });

  it('no credentials in error logs on token request failure', async () => {
    const AUTH_KEY = 'super-secret-auth-key-99999';
    const logs = [];

    const origError = console.error;
    const origLog = console.log;
    const origWarn = console.warn;
    console.error = (...args) => logs.push(args.join(' '));
    console.log = (...args) => logs.push(args.join(' '));
    console.warn = (...args) => logs.push(args.join(' '));

    try {
      const mockFetch = async (url, opts) => {
        if (url.includes('oauth')) {
          return {
            ok: false,
            status: 403,
            statusText: 'Forbidden',
            json: async () => ({ error: 'invalid credentials' }),
            text: async () => '{"error":"invalid credentials"}',
          };
        }
        throw new Error(`Unhandled: ${url}`);
      };

      const provider = new GigaChatProvider({
        fetchFn: mockFetch,
        authKey: AUTH_KEY,
        model: 'GigaChat-2',
        certPath: null,
      });

      try {
        await provider.complete('sys', 'msg');
      } catch {
        // Expected
      }

      const allLogs = logs.join('\n');
      expect(allLogs).not.toContain(AUTH_KEY);
    } finally {
      console.error = origError;
      console.log = origLog;
      console.warn = origWarn;
    }
  });

  it('handles empty choices array gracefully', async () => {
    const mockFetch = createMockFetch([
      { match: 'oauth', status: 200, body: tokenResponse() },
      {
        match: 'chat/completions',
        status: 200,
        body: { choices: [] },
      },
    ]);

    const provider = new GigaChatProvider({
      fetchFn: mockFetch,
      authKey: 'dGVzdC1rZXk=',
      model: 'GigaChat-2',
      certPath: null,
    });

    await expect(provider.complete('sys', 'msg')).rejects.toThrow(
      /empty|missing|no content/i,
    );
  });

  it('retries once on network error during completion', async () => {
    let completionCalls = 0;
    const mockFetch = async (url, opts) => {
      if (url.includes('oauth')) {
        return {
          ok: true,
          status: 200,
          json: async () => tokenResponse(),
          text: async () => JSON.stringify(tokenResponse()),
        };
      }
      if (url.includes('chat/completions')) {
        completionCalls++;
        if (completionCalls === 1) {
          throw new Error('ECONNREFUSED');
        }
        return {
          ok: true,
          status: 200,
          json: async () => completionResponse('recovered'),
          text: async () => JSON.stringify(completionResponse('recovered')),
        };
      }
      throw new Error(`Unhandled: ${url}`);
    };

    const provider = new GigaChatProvider({
      fetchFn: mockFetch,
      authKey: 'dGVzdC1rZXk=',
      model: 'GigaChat-2',
      certPath: null,
    });

    const result = await provider.complete('sys', 'msg');
    expect(result).toBe('recovered');
    expect(completionCalls).toBe(2);
  });
});
