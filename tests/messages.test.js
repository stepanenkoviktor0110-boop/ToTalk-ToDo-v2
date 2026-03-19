import { describe, it, expect } from '@jest/globals';
import { WELCOME, NON_VOICE_EXPLANATION, GENERIC_ERROR } from '../src/utils/messages.js';

describe('messages module', () => {
  it('should export WELCOME message containing trial info', () => {
    expect(typeof WELCOME).toBe('string');
    expect(WELCOME.length).toBeGreaterThan(0);
    // Must reference 30 free voices
    expect(WELCOME).toMatch(/30/);
  });

  it('should export NON_VOICE_EXPLANATION message', () => {
    expect(typeof NON_VOICE_EXPLANATION).toBe('string');
    expect(NON_VOICE_EXPLANATION.length).toBeGreaterThan(0);
  });

  it('should export GENERIC_ERROR message', () => {
    expect(typeof GENERIC_ERROR).toBe('string');
    expect(GENERIC_ERROR.length).toBeGreaterThan(0);
    // Must not contain technical details
    expect(GENERIC_ERROR).not.toMatch(/stack/i);
    expect(GENERIC_ERROR).not.toMatch(/error/i);
    expect(GENERIC_ERROR).not.toMatch(/exception/i);
  });
});
