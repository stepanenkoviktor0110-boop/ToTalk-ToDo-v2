/**
 * Base LLM provider interface.
 * All LLM implementations must extend this class and implement complete().
 */
export class LLMProvider {
  /**
   * Send a system prompt and user message to the LLM and get a text response.
   * @param {string} systemPrompt - The system-level instruction
   * @param {string} userMessage - The user's message content
   * @returns {Promise<string>} The LLM's text response
   */
  async complete(systemPrompt, userMessage) {
    throw new Error('not implemented');
  }
}
