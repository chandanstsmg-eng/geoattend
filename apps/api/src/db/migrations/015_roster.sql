-- Dated roster. A shift assignment is now a roster entry: shift (which fixes the workplace and the
-- times) + the manager responsible + a date range. An employee may be rostered at several
-- workplaces under different managers, e.g. one workplace this week and another next week.
-- The employee's single "home" workplace (workplace_assignments) stays as their default site.
ALTER TABLE employee_shift_assignments ADD COLUMN manager_id UUID REFERENCES users(id);

-- The same shift may now appear in several entries with different date ranges (this week, then
-- again in three weeks). Overlaps are refused by the API, which also checks clashing times.
DROP INDEX esa_current_uq;
CREATE INDEX esa_employee_dates_idx ON employee_shift_assignments (employee_id, effective_from, effective_to);
CREATE INDEX esa_manager_idx ON employee_shift_assignments (manager_id) WHERE manager_id IS NOT NULL;
