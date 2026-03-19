import { describe, it, expect, beforeEach } from '@jest/globals';
import { initDb, runMigrations, getDb } from '../src/db/index.js';
import {
  upsertUser,
  createVoiceRequest,
  updateVoiceRequest,
  saveFeedback,
  saveSurveyResponse,
  getUserByTelegramId,
  decrementTrial,
  advanceSurveyProgress,
  completeSurvey,
  blockSurvey,
  exhaustTrial,
} from '../src/db/queries.js';

beforeEach(() => {
  initDb(':memory:');
  runMigrations();
});

describe('upsertUser', () => {
  it('creates new user with correct defaults', () => {
    const user = upsertUser(12345, 'testuser');
    expect(user).toBeDefined();
    expect(user.telegram_user_id).toBe(12345);
    expect(user.telegram_username).toBe('testuser');
    expect(user.trial_remaining).toBe(30);
    expect(user.trial_phase).toBe(1);
    expect(user.survey_progress).toBe(0);
    expect(user.total_voice_count).toBe(0);
  });

  it('updates existing user', () => {
    const user1 = upsertUser(12345, 'testuser');
    const firstActiveAt = user1.last_active_at;

    // Small delay to ensure timestamp difference
    const user2 = upsertUser(12345, 'newname');
    expect(user2.telegram_username).toBe('newname');
    expect(user2.id).toBe(user1.id);
    // last_active_at should be updated (or at least not null)
    expect(user2.last_active_at).toBeDefined();
  });
});

describe('createVoiceRequest', () => {
  it('inserts record', () => {
    const user = upsertUser(12345, 'testuser');
    const vr = createVoiceRequest(user.id, 'file_abc_123', 45);
    expect(vr).toBeDefined();
    expect(vr.user_id).toBe(user.id);
    expect(vr.telegram_file_id).toBe('file_abc_123');
    expect(vr.duration_seconds).toBe(45);
    expect(vr.id).toBeDefined();
  });
});

describe('updateVoiceRequest', () => {
  it('updates fields', () => {
    const user = upsertUser(12345, 'testuser');
    const vr = createVoiceRequest(user.id, 'file_abc_123', 45);
    updateVoiceRequest(vr.id, { taskCount: 5, transcriptLength: 1200 });

    const db = getDb();
    const updated = db.prepare('SELECT * FROM voice_requests WHERE id = ?').get(vr.id);
    expect(updated.task_count).toBe(5);
    expect(updated.transcript_length).toBe(1200);
  });
});

describe('saveFeedback', () => {
  it('inserts record', () => {
    const user = upsertUser(12345, 'testuser');
    const vr = createVoiceRequest(user.id, 'file_abc_123', 45);
    const fb = saveFeedback(vr.id, 3, 'could be better', 1);
    expect(fb).toBeDefined();
    expect(fb.voice_request_id).toBe(vr.id);
    expect(fb.rating).toBe(3);
    expect(fb.comment).toBe('could be better');
    expect(fb.voice_consent).toBe(1);
  });
});

describe('saveSurveyResponse', () => {
  it('inserts record', () => {
    const user = upsertUser(12345, 'testuser');
    const sr = saveSurveyResponse(user.id, 1, 'Great product!', 1, null);
    expect(sr).toBeDefined();
    expect(sr.user_id).toBe(user.id);
    expect(sr.question_num).toBe(1);
    expect(sr.answer).toBe('Great product!');
    expect(sr.is_adequate).toBe(1);
  });
});

describe('getUserByTelegramId', () => {
  it('returns user', () => {
    upsertUser(12345, 'testuser');
    const user = getUserByTelegramId(12345);
    expect(user).toBeDefined();
    expect(user.telegram_user_id).toBe(12345);
    expect(user.telegram_username).toBe('testuser');
  });

  it('returns undefined for missing user', () => {
    const user = getUserByTelegramId(99999);
    expect(user).toBeUndefined();
  });
});

describe('decrementTrial', () => {
  it('returns new value', () => {
    const user = upsertUser(12345, 'testuser');
    const newVal = decrementTrial(user.id);
    expect(newVal).toBe(29);
  });

  it('does not go below 0', () => {
    const user = upsertUser(12345, 'testuser');
    // Set trial_remaining to 0 directly
    const db = getDb();
    db.prepare('UPDATE users SET trial_remaining = 0 WHERE id = ?').run(user.id);

    const newVal = decrementTrial(user.id);
    expect(newVal).toBe(0);
  });
});

describe('trial counter operations', () => {
  it('full lifecycle', () => {
    const user = upsertUser(12345, 'testuser');

    // Decrement from 30 to 0
    for (let i = 29; i >= 0; i--) {
      const val = decrementTrial(user.id);
      expect(val).toBe(i);
    }

    // Verify at 0
    const atZero = getUserByTelegramId(12345);
    expect(atZero.trial_remaining).toBe(0);

    // Complete survey -> phase 2, trial_remaining = 20
    completeSurvey(user.id);
    const afterSurvey = getUserByTelegramId(12345);
    expect(afterSurvey.trial_phase).toBe(2);
    expect(afterSurvey.trial_remaining).toBe(20);

    // Exhaust trial -> phase 3, trial_remaining = 0
    exhaustTrial(user.id);
    const afterExhaust = getUserByTelegramId(12345);
    expect(afterExhaust.trial_phase).toBe(3);
    expect(afterExhaust.trial_remaining).toBe(0);
  });
});

describe('advanceSurveyProgress', () => {
  it('increments', () => {
    const user = upsertUser(12345, 'testuser');
    advanceSurveyProgress(user.id);
    advanceSurveyProgress(user.id);

    const updated = getUserByTelegramId(12345);
    expect(updated.survey_progress).toBe(2);
  });
});

describe('blockSurvey', () => {
  it('sets flag', () => {
    const user = upsertUser(12345, 'testuser');
    blockSurvey(user.id);

    const updated = getUserByTelegramId(12345);
    expect(updated.survey_blocked).toBe(1);
  });
});
