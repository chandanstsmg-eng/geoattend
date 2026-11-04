-- One name per time zone: "Asia/Calcutta" is a legacy alias of "Asia/Kolkata" (identical rules,
-- so no stored time changes). New input is canonicalised by the API.
UPDATE workplaces SET timezone = 'Asia/Kolkata', updated_at = now() WHERE timezone = 'Asia/Calcutta';
UPDATE shifts SET timezone = 'Asia/Kolkata', updated_at = now() WHERE timezone = 'Asia/Calcutta';
