import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { LLMProvider } from './provider.js';

const TOKEN_URL = 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth';
const CHAT_URL =
  'https://gigachat.devices.sberbank.ru/api/v1/chat/completions';

// Refresh token if less than this many ms remain
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * GigaChat LLM provider.
 *
 * Handles OAuth2 token lifecycle (proactive refresh, 401 retry),
 * retry on 5xx/network errors, 15s timeout, and TLS with Sberbank CA cert.
 *
 * Constructor accepts an options object for dependency injection in tests:
 *   { fetchFn, authKey, model, certPath, timeoutMs }
 */
export class GigaChatProvider extends LLMProvider {
  /**
   * @param {object} opts
   * @param {Function} [opts.fetchFn] - fetch implementation (injected for tests)
   * @param {string}   [opts.authKey] - base64 client credentials (or from env GIGACHAT_AUTH_KEY)
   * @param {string}   [opts.model]   - model name (default: env GIGACHAT_MODEL or 'GigaChat-2')
   * @param {string|null} [opts.certPath] - path to CA cert PEM file; null to skip
   * @param {number}   [opts.timeoutMs] - request timeout (default 15000)
   */
  constructor(opts = {}) {
    super();
    this._authKey = opts.authKey ?? process.env.GIGACHAT_AUTH_KEY;
    if (!this._authKey) {
      throw new Error('GIGACHAT_AUTH_KEY is required');
    }
    this._model = opts.model ?? process.env.GIGACHAT_MODEL ?? 'GigaChat-2';
    this._timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Token state
    this._accessToken = null;
    this._expiresAt = 0;
    this._refreshPromise = null;

    // HTTPS agent with custom CA cert for Sberbank domains.
    // this._agent MUST only be used for Sberbank domain endpoints;
    // _fetchWithTimeout enforces a hostname check before attaching it.
    this._agent = null;
    const certPath =
      opts.certPath !== undefined
        ? opts.certPath
        : fileURLToPath(
            new URL('../../../certs/russian_trusted_root_ca.cer', import.meta.url),
          );
    if (certPath) {
      try {
        const certRaw = readFileSync(certPath);
        // Support both PEM and DER formats
        const isPem = certRaw.toString('utf8', 0, 27).includes('-----BEGIN');
        const pem = isPem
          ? certRaw
          : `-----BEGIN CERTIFICATE-----\n${certRaw.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
        // rejectUnauthorized:false is intentional — Sberbank uses a Russian government
        // CA not trusted by default; the agent is only attached to *.sberbank.ru endpoints.
        this._agent = new https.Agent({ ca: pem, rejectUnauthorized: false });
      } catch (err) {
        throw new Error(
          `Failed to load CA cert from ${certPath}: ${err.message}`,
        );
      }
    }

    // Injected or real fetch
    if (opts.fetchFn) {
      this._fetch = opts.fetchFn;
    } else {
      // Dynamic import of node-fetch at first use
      this._fetchPromise = import('node-fetch').then((m) => m.default);
      this._fetch = null;
    }
  }

  /**
   * Get the fetch function (lazy-loaded for real usage).
   */
  async _getFetch() {
    if (this._fetch) return this._fetch;
    this._fetch = await this._fetchPromise;
    return this._fetch;
  }

  /**
   * Fetch with AbortController timeout.
   */
  async _fetchWithTimeout(url, options) {
    const fetchFn = await this._getFetch();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this._timeoutMs);

    // Only attach custom CA agent for Sberbank domains
    let agent;
    if (this._agent) {
      const hostname = new URL(url).hostname;
      if (hostname.endsWith('.sberbank.ru')) {
        agent = this._agent;
      }
    }

    try {
      const response = await fetchFn(url, {
        ...options,
        signal: controller.signal,
        ...(agent ? { agent } : {}),
      });
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Acquire or refresh the OAuth2 access token.
   * Logs only status code and body on failure -- never request headers (Decision 16).
   */
  async _refreshToken() {
    let response;
    try {
      response = await this._fetchWithTimeout(TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          Authorization: `Basic ${this._authKey}`,
          RqUID: randomUUID(),
        },
        body: 'scope=GIGACHAT_API_PERS',
      });
    } catch (err) {
      // Network / timeout error during token fetch
      throw new Error(`GigaChat token request failed: ${err.message}`);
    }

    if (!response.ok) {
      // Log only status and body -- NEVER serialize request headers
      let bodyText;
      try {
        bodyText = await response.text();
      } catch {
        bodyText = '(unreadable)';
      }
      console.error(
        `GigaChat token error: status=${response.status}, body=${bodyText}`,
      );
      throw new Error(
        `GigaChat token request failed with status ${response.status}`,
      );
    }

    const data = await response.json();
    if (!data.access_token || !data.expires_at) {
      throw new Error(
        'GigaChat token response missing access_token or expires_at',
      );
    }

    this._accessToken = data.access_token;
    this._expiresAt = data.expires_at;
  }

  /**
   * Ensure we have a valid token. Proactively refresh if <60s to expiry.
   * Avoids parallel refresh with a shared promise.
   */
  async _ensureToken() {
    const needsRefresh =
      !this._accessToken ||
      Date.now() >= this._expiresAt - TOKEN_REFRESH_MARGIN_MS;

    if (!needsRefresh) return;

    // If another call is already refreshing, wait for it
    if (this._refreshPromise) {
      await this._refreshPromise;
      return;
    }

    this._refreshPromise = this._refreshToken().finally(() => {
      this._refreshPromise = null;
    });

    await this._refreshPromise;
  }

  /**
   * Make the chat completion API call.
   */
  async _chatCompletion(systemPrompt, userMessage) {
    const response = await this._fetchWithTimeout(CHAT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${this._accessToken}`,
      },
      body: JSON.stringify({
        model: this._model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
      }),
    });

    return response;
  }

  /**
   * Send a system prompt and user message to GigaChat.
   * Handles proactive token refresh, 401 retry, 5xx/network retry, and timeout.
   *
   * @param {string} systemPrompt
   * @param {string} userMessage
   * @returns {Promise<string>}
   */
  async complete(systemPrompt, userMessage) {
    await this._ensureToken();

    let response;
    try {
      response = await this._chatCompletion(systemPrompt, userMessage);
    } catch (err) {
      // Network error on first attempt -- retry once
      if (err.name === 'AbortError' || err.type === 'aborted') {
        throw new Error('GigaChat request timed out');
      }
      console.error(
        `GigaChat completion network error (attempt 1): ${err.message}`,
      );
      try {
        response = await this._chatCompletion(systemPrompt, userMessage);
      } catch (retryErr) {
        if (retryErr.name === 'AbortError' || retryErr.type === 'aborted') {
          throw new Error('GigaChat request timed out');
        }
        throw new Error(
          `GigaChat completion failed after retry: ${retryErr.message}`,
        );
      }
    }

    // Handle 401: refresh token via dedup guard and retry exactly once
    if (response.status === 401) {
      console.error('GigaChat completion returned 401, refreshing token');
      this._accessToken = null;
      this._expiresAt = 0;
      await this._ensureToken();
      try {
        response = await this._chatCompletion(systemPrompt, userMessage);
      } catch (retryErr) {
        if (retryErr.name === 'AbortError' || retryErr.type === 'aborted') {
          throw new Error('GigaChat request timed out');
        }
        throw new Error(
          `GigaChat completion failed after 401 retry: ${retryErr.message}`,
        );
      }
      if (!response.ok) {
        const bodyText = await response.text().catch(() => '(unreadable)');
        console.error(
          `GigaChat completion error after 401 retry: status=${response.status}, body=${bodyText}`,
        );
        throw new Error(
          `GigaChat completion failed with status ${response.status} after 401 retry`,
        );
      }
    }

    // Handle 5xx: retry exactly once
    if (response.status >= 500) {
      console.error(
        `GigaChat completion returned ${response.status}, retrying once`,
      );
      try {
        response = await this._chatCompletion(systemPrompt, userMessage);
      } catch (retryErr) {
        throw new Error(
          `GigaChat completion retry failed: ${retryErr.message}`,
        );
      }
      if (!response.ok) {
        const bodyText = await response.text().catch(() => '(unreadable)');
        console.error(
          `GigaChat completion error after retry: status=${response.status}, body=${bodyText}`,
        );
        throw new Error(
          `GigaChat completion failed with status ${response.status} after retry`,
        );
      }
    }

    // Handle other 4xx: no retry
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '(unreadable)');
      console.error(
        `GigaChat completion error: status=${response.status}, body=${bodyText}`,
      );
      throw new Error(
        `GigaChat completion failed with status ${response.status}`,
      );
    }

    // Parse and validate response
    const data = await response.json();
    if (!data.choices || data.choices.length === 0 || !data.choices[0].message?.content) {
      throw new Error(
        'GigaChat response missing or empty choices',
      );
    }

    return data.choices[0].message.content;
  }
}
