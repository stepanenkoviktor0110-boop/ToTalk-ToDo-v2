import { getDb } from './index.js';

/**
 * Insert a new user or update existing user's username and last_active_at.
 * @param {number} telegramUserId
 * @param {string} telegramUsername
 * @returns {object} The user row
 */
export function upsertUser(telegramUserId, telegramUsername) {
  const db = getDb();
  db.prepare(`
    INSERT INTO users (telegram_user_id, telegram_username, trial_remaining)
    VALUES (?, ?, 20)
    ON CONFLICT(telegram_user_id) DO UPDATE SET
      telegram_username = excluded.telegram_username,
      last_active_at = CURRENT_TIMESTAMP
  `).run(telegramUserId, telegramUsername);

  return db.prepare('SELECT * FROM users WHERE telegram_user_id = ?').get(telegramUserId);
}

/**
 * Create a new voice request record.
 * @param {number} userId - The internal user ID
 * @param {string} fileId - Telegram file ID
 * @param {number} durationSeconds
 * @returns {object} The new voice_requests row
 */
export function createVoiceRequest(userId, fileId, durationSeconds) {
  const result = getDb().prepare(`
    INSERT INTO voice_requests (user_id, telegram_file_id, duration_seconds)
    VALUES (?, ?, ?)
  `).run(userId, fileId, durationSeconds);

  return getDb().prepare('SELECT * FROM voice_requests WHERE id = ?').get(result.lastInsertRowid);
}

/**
 * Update specified fields on a voice request.
 * @param {number} id - Voice request ID
 * @param {object} fields - Fields to update: { taskCount, transcriptLength, audioPath, actionType, summaryLength }
 */
export function updateVoiceRequest(id, { taskCount, transcriptLength, audioPath, actionType, summaryLength } = {}) {
  const db = getDb();
  const sets = [];
  const values = [];

  if (taskCount !== undefined && taskCount !== null) {
    sets.push('task_count = ?');
    values.push(taskCount);
  }
  if (transcriptLength !== undefined && transcriptLength !== null) {
    sets.push('transcript_length = ?');
    values.push(transcriptLength);
  }
  if (audioPath !== undefined && audioPath !== null) {
    sets.push('audio_path = ?');
    values.push(audioPath);
  }
  if (actionType !== undefined && actionType !== null) {
    sets.push('action_type = ?');
    values.push(actionType);
  }
  if (summaryLength !== undefined && summaryLength !== null) {
    sets.push('summary_length = ?');
    values.push(summaryLength);
  }

  if (sets.length === 0) return;

  values.push(id);
  db.prepare(`UPDATE voice_requests SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

/**
 * Save a feedback record.
 * @param {number} voiceRequestId
 * @param {number} rating - 1-5
 * @param {string|null} comment
 * @param {number} voiceConsent - 0 or 1
 * @returns {object} The new feedback row
 */
export function saveFeedback(voiceRequestId, rating, comment, voiceConsent) {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO feedback (voice_request_id, rating, comment, voice_consent)
    VALUES (?, ?, ?, ?)
  `).run(voiceRequestId, rating, comment, voiceConsent);

  return db.prepare('SELECT * FROM feedback WHERE id = ?').get(result.lastInsertRowid);
}

/**
 * Save a survey response.
 * @param {number} userId
 * @param {number} questionNum
 * @param {string} answer
 * @param {number} isAdequate - 0 or 1
 * @param {string|null} rejectionReason
 * @returns {object} The new survey_responses row
 */
export function saveSurveyResponse(userId, questionNum, answer, isAdequate, rejectionReason) {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO survey_responses (user_id, question_num, answer, is_adequate, rejection_reason)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, questionNum, answer, isAdequate, rejectionReason);

  return db.prepare('SELECT * FROM survey_responses WHERE id = ?').get(result.lastInsertRowid);
}

/**
 * Get a voice request by ID.
 * @param {number} id
 * @returns {object|undefined}
 */
export function getVoiceRequest(id) {
  return getDb().prepare('SELECT * FROM voice_requests WHERE id = ?').get(id);
}

/**
 * Get a user by their Telegram user ID.
 * @param {number} telegramUserId
 * @returns {object|undefined}
 */
export function getUserByTelegramId(telegramUserId) {
  return getDb().prepare('SELECT * FROM users WHERE telegram_user_id = ?').get(telegramUserId);
}

/**
 * Decrement a user's trial_remaining by 1 (minimum 0).
 * @param {number} userId - Internal user ID
 * @returns {number} The new trial_remaining value
 */
export function decrementTrial(userId) {
  const db = getDb();
  db.prepare(`
    UPDATE users SET trial_remaining = MAX(trial_remaining - 1, 0) WHERE id = ?
  `).run(userId);

  const row = db.prepare('SELECT trial_remaining FROM users WHERE id = ?').get(userId);
  return row.trial_remaining;
}

/**
 * Advance survey_progress by 1.
 * @param {number} userId
 */
export function advanceSurveyProgress(userId) {
  getDb().prepare('UPDATE users SET survey_progress = survey_progress + 1 WHERE id = ?').run(userId);
}

/**
 * Complete the survey: set trial_phase=2, trial_remaining=10.
 * @param {number} userId
 */
export function completeSurvey(userId) {
  getDb().prepare('UPDATE users SET trial_phase = 2, trial_remaining = 10 WHERE id = ?').run(userId);
}

/**
 * Block survey access permanently: set survey_blocked=1.
 * @param {number} userId
 */
export function blockSurvey(userId) {
  getDb().prepare('UPDATE users SET survey_blocked = 1 WHERE id = ?').run(userId);
}

/**
 * Exhaust trial: set trial_phase=3, trial_remaining=0.
 * @param {number} userId
 */
export function exhaustTrial(userId) {
  getDb().prepare('UPDATE users SET trial_phase = 3, trial_remaining = 0 WHERE id = ?').run(userId);
}
