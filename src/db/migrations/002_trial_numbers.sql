-- Migration 002: Trial numbers update + action tracking columns
-- Changes:
--   1. users.trial_remaining default: 30 → 20 (new users only)
--   2. completeSurvey bonus: +20 → +10
--   3. voice_requests: add action_type and summary_length columns

-- Add new columns to voice_requests (nullable, backward-compatible)
ALTER TABLE voice_requests ADD COLUMN action_type TEXT;
ALTER TABLE voice_requests ADD COLUMN summary_length INTEGER;
