-- Suspicious location readings are kept and flagged, never discarded. Rollback: docs/migrations/031_rollback.sql.
-- Two nullable columns on location_updates. Existing rows keep NULL (= not suspicious) and change meaning in no way;
-- adding nullable columns without a default rewrites no row. Code from before this migration ignores them.
--   suspect_reason     why the reading was left out of automatic decisions: IMPOSSIBLE_SPEED (it implies moving
--                      faster than Settings › Tracking › maxPlausibleSpeedKmh from the last reading that was not flagged)
--   implied_speed_kmh  that speed, for managers reading the trail
ALTER TABLE location_updates
  ADD COLUMN suspect_reason TEXT CHECK (suspect_reason IN ('IMPOSSIBLE_SPEED')),
  ADD COLUMN implied_speed_kmh REAL;
