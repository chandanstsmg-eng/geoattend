-- Employee IDs (codes) are unique within a company, not across all companies:
-- two businesses can both have an "EMP-001".
ALTER TABLE employee_profiles ADD COLUMN org_id UUID REFERENCES organizations(id);
UPDATE employee_profiles ep SET org_id = u.org_id FROM users u WHERE u.id = ep.user_id;
ALTER TABLE employee_profiles ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE employee_profiles DROP CONSTRAINT employee_profiles_employee_code_key;
CREATE UNIQUE INDEX employee_profiles_code_uq ON employee_profiles (org_id, employee_code);

-- Filled from the user, so every insert path gets it right without having to pass it.
CREATE FUNCTION employee_profiles_set_org() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.org_id := (SELECT org_id FROM users WHERE id = NEW.user_id);
  RETURN NEW;
END $$;
CREATE TRIGGER employee_profiles_org BEFORE INSERT OR UPDATE OF user_id ON employee_profiles FOR EACH ROW EXECUTE FUNCTION employee_profiles_set_org();
