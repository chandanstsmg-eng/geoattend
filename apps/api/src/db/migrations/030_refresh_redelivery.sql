-- A refresh whose answer was lost can be answered again with the same new token. Rollback: docs/migrations/030_rollback.sql.
-- Two nullable columns on refresh_tokens: no existing row changes meaning, and old app builds keep working as before.
--   rotation_key_hash  SHA-256 of the one-time request id the phone sent with the refresh that rotated this token
--   successor_box      the new token, AES-256-GCM encrypted with a key derived from THIS (old) raw token and that
--                      request id. The server stores only hashes of raw tokens, so a copy of the database cannot open it.
ALTER TABLE refresh_tokens ADD COLUMN rotation_key_hash TEXT, ADD COLUMN successor_box TEXT;
