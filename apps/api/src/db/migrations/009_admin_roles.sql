-- Administrator roles within a company.
--  OWNER       everything in the company.
--  SUPERVISOR  day-to-day work (live map, attendance, leave, approvals…) for the workplaces in
--              site_ids only; no settings, payroll, audit log or setup changes.
-- away_until: the administrator is away; push / e-mail alerts are not sent to them meanwhile.
ALTER TABLE administrator_profiles
  ADD COLUMN access     TEXT NOT NULL DEFAULT 'OWNER' CHECK (access IN ('OWNER', 'SUPERVISOR')),
  ADD COLUMN site_ids   UUID[] NOT NULL DEFAULT '{}',
  ADD COLUMN away_until DATE;
