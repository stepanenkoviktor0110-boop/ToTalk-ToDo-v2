/**
 * OpenRouter LLM provider — replaces GigaChat.
 *
 * Implements the same interface as the old GigaChatProvider:
 *   complete(systemPrompt, userMessage) => Promise<string>
 *
 * Uses node-fetch v3. No OAuth, no CA certs, no Sberbank.
 */

const DEFAULT_MODEL = 'qwen/qwen-2.5-72b-instruct';
const DEFAULT_TIMEOUT_MS = 30_000;

export class OpenRouterProvider {
  constructor(opts = {}) {
    this._apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY;
    if (!this._apiKey) {
      throw new Error('OPENROUTER_API_KEY is required');
    }
    this._model = opts.model ?? process.env.LLM_MODEL ?? DEFAULT_MODEL;
    this._timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this._baseUrl = 'https://openrouter.ai/api/v1';

    // Lazy-loaded fetch
    this._fetchPromise = import('node-fetch').then((m) => m.default);
  }

  async _getFetch() {
    return await this._fetchPromise;
  }

  async complete(systemPrompt, userMessage) {
    const fetchFn = await this._getFetch();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this._timeoutMs);

    let response;
    try {
      response = await fetchFn(`${this._baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this._apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/stepanenkoviktor0110-boop/ToTalk-ToDo',
          'X-Title': 'ToTalk-ToDo',
        },
        body: JSON.stringify({
          model: this._model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
          ],
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '(unreadable)');
      throw new Error(`OpenRouter error ${response.status}: ${body}`);
    }

    const data = await response.json();
    if (!data.choices || !data.choices[0]?.message?.content) {
      throw new Error('OpenRouter response missing or empty');
    }

    return data.choices[0].message.content;
  }
}
