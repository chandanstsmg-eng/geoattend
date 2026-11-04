-- Arrival is confirmed on two clocks: the phone's (time between fixes) and the server's (when the
-- readings arrived). The phone's clock can be set freely, so a batch of made-up readings uploaded at
-- once no longer unlocks attendance (Settings › tracking › entryMinServerSpanSec).
ALTER TABLE tracking_sessions ADD COLUMN candidate_received_since TIMESTAMPTZ;
