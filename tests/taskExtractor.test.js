import { describe, it, expect, beforeEach } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROMPT_PATH = join(__dirname, '..', 'prompts', 'task-extraction.md');

describe('taskExtractor', () => {
  let extractTasks;

  beforeEach(async () => {
    const mod = await import('../src/services/taskExtractor.js');
    extractTasks = mod.extractTasks;
  });

  it('returns parsed numbered list', async () => {
    const mockProvider = {
      complete: async () => '1. Call mom\n2. Buy groceries',
    };

    const result = await extractTasks(['some transcript'], mockProvider);
    expect(result.tasks).toEqual(['Call mom', 'Buy groceries']);
    expect(result.marker).toBeNull();
    expect(result.error).toBeUndefined();
  });

  it('handles NO_TASKS marker', async () => {
    const mockProvider = {
      complete: async () => '__NO_TASKS__',
    };

    const result = await extractTasks(['just thinking aloud'], mockProvider);
    expect(result.tasks).toEqual([]);
    expect(result.marker).toBe('no_tasks');
  });

  it('handles TOO_MANY_TASKS marker', async () => {
    const mockProvider = {
      complete: async () => '__TOO_MANY_TASKS__',
    };

    const result = await extractTasks(['lots of stuff'], mockProvider);
    expect(result.tasks).toEqual([]);
    expect(result.marker).toBe('too_many_tasks');
  });

  it('returns format_error on unexpected response', async () => {
    const mockProvider = {
      complete: async () => 'Here is some free-form text without any numbered list.',
    };

    const result = await extractTasks(['transcript'], mockProvider);
    expect(result.tasks).toEqual([]);
    expect(result.marker).toBeNull();
    expect(result.error).toBe('format_error');
  });

  it('truncates transcript at 4000 chars', async () => {
    let capturedUserMessage;
    const mockProvider = {
      complete: async (sys, user) => {
        capturedUserMessage = user;
        return '1. Task one';
      },
    };

    const longText = 'A'.repeat(5000);
    const result = await extractTasks([longText], mockProvider);

    expect(capturedUserMessage.length).toBe(4000);
    expect(result.truncated).toBe(true);
    expect(result.tasks).toEqual(['Task one']);
  });

  it('does not mark as truncated when exactly 4000 chars', async () => {
    let capturedUserMessage;
    const mockProvider = {
      complete: async (sys, user) => {
        capturedUserMessage = user;
        return '1. Task one';
      },
    };

    const exactText = 'B'.repeat(4000);
    const result = await extractTasks([exactText], mockProvider);

    expect(capturedUserMessage.length).toBe(4000);
    expect(result.truncated).toBe(false);
  });

  it('concatenates multiple transcripts', async () => {
    let capturedUserMessage;
    const mockProvider = {
      complete: async (sys, user) => {
        capturedUserMessage = user;
        return '1. Task A\n2. Task B\n3. Task C';
      },
    };

    const result = await extractTasks(
      ['first part', 'second part', 'third part'],
      mockProvider,
    );

    expect(capturedUserMessage).toBe('first part\nsecond part\nthird part');
    expect(result.tasks).toHaveLength(3);
  });

  it('reads system prompt from file', async () => {
    const expectedPrompt = readFileSync(PROMPT_PATH, 'utf-8');

    let capturedSystemPrompt;
    const mockProvider = {
      complete: async (sys, user) => {
        capturedSystemPrompt = sys;
        return '1. Some task';
      },
    };

    await extractTasks(['test'], mockProvider);
    expect(capturedSystemPrompt).toBe(expectedPrompt);
  });

  it('propagates LLM errors', async () => {
    const mockProvider = {
      complete: async () => {
        throw new Error('LLM is down');
      },
    };

    await expect(extractTasks(['test'], mockProvider)).rejects.toThrow(
      'LLM is down',
    );
  });

  it('handles numbered list with extra whitespace', async () => {
    const mockProvider = {
      complete: async () => '  1.  Call mom  \n\n  2.  Buy milk  \n',
    };

    const result = await extractTasks(['test'], mockProvider);
    expect(result.tasks).toEqual(['Call mom', 'Buy milk']);
  });

  it('handles markers with surrounding whitespace', async () => {
    const mockProvider = {
      complete: async () => '  \n  __NO_TASKS__  \n  ',
    };

    const result = await extractTasks(['test'], mockProvider);
    expect(result.tasks).toEqual([]);
    expect(result.marker).toBe('no_tasks');
  });

  it('handles empty transcript array gracefully', async () => {
    let capturedUserMessage;
    const mockProvider = {
      complete: async (sys, user) => {
        capturedUserMessage = user;
        return '__NO_TASKS__';
      },
    };

    const result = await extractTasks([], mockProvider);
    expect(capturedUserMessage).toBe('');
    expect(result.tasks).toEqual([]);
  });
});
