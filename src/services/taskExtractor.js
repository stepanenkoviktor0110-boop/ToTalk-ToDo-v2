/**
 * Task extraction orchestrator.
 *
 * Reads the system prompt from prompts/task-extraction.md, sends transcript
 * to the LLM provider, and parses the response into a structured result.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MAX_TRANSCRIPT_LENGTH = 4000;

// Lazily cached system prompt (read once from file)
let cachedPrompt = null;

function getSystemPrompt() {
  if (cachedPrompt !== null) return cachedPrompt;

  const thisFile = fileURLToPath(import.meta.url);
  const thisDir = dirname(thisFile);
  const promptPath = join(thisDir, '..', '..', 'prompts', 'task-extraction.md');
  cachedPrompt = readFileSync(promptPath, 'utf-8');
  return cachedPrompt;
}

/**
 * Parse LLM response into structured result.
 *
 * @param {string} response - raw LLM response text
 * @returns {{ tasks: string[], marker: string|null, error?: string }}
 */
function parseResponse(response) {
  const trimmed = response.trim();

  // Check for markers — anchored to start to resist prompt injection
  if (trimmed.startsWith('__NO_TASKS__')) {
    return { tasks: [], marker: 'no_tasks' };
  }
  if (trimmed.startsWith('__TOO_MANY_TASKS__')) {
    return { tasks: [], marker: 'too_many_tasks' };
  }

  // Try to parse as numbered list: lines matching "N. Text"
  const taskRegex = /^\s*\d+\.\s+(.+)$/gm;
  const tasks = [];
  let match;
  while ((match = taskRegex.exec(trimmed)) !== null) {
    const taskText = match[1].trim();
    if (taskText) {
      tasks.push(taskText);
    }
  }

  if (tasks.length > 0) {
    return { tasks, marker: null };
  }

  // No recognized format — log for audit trail (Decision 12: timestamps, Decision 16: no PII)
  console.error(`[${new Date().toISOString()}] taskExtractor: unexpected LLM response format, length=${trimmed.length}`);
  return { tasks: [], marker: null, error: 'format_error' };
}

/**
 * Extract tasks from transcript(s) using an LLM provider.
 *
 * @param {string[]} transcripts - array of transcript strings
 * @param {{ complete: (systemPrompt: string, userMessage: string) => Promise<string> }} llmProvider
 * @returns {Promise<{ tasks: string[], marker: string|null, truncated: boolean, error?: string }>}
 */
export async function extractTasks(transcripts, llmProvider) {
  const systemPrompt = getSystemPrompt();

  // Concatenate transcripts with newline separator
  let combined = transcripts.join('\n');

  // Truncate if needed
  let truncated = false;
  if (combined.length > MAX_TRANSCRIPT_LENGTH) {
    combined = combined.slice(0, MAX_TRANSCRIPT_LENGTH);
    truncated = true;
  }

  const response = await llmProvider.complete(systemPrompt, combined);
  const result = parseResponse(response);

  return {
    ...result,
    truncated,
  };
}
