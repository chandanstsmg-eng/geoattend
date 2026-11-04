-- Payroll-lite: pay setup per employee, monthly adjustments (advances, bonuses…),
-- and approved monthly payroll runs with a payslip snapshot per employee.

CREATE TABLE employee_pay (
  employee_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  pay_type       TEXT NOT NULL CHECK (pay_type IN ('MONTHLY', 'DAILY', 'HOURLY')),
  amount         NUMERIC(12,2) NOT NULL CHECK (amount >= 0),          -- per month / day / hour
  ot_multiplier  NUMERIC(4,2) NOT NULL DEFAULT 1.0 CHECK (ot_multiplier BETWEEN 0 AND 5),
  hours_per_day  NUMERIC(4,2) NOT NULL DEFAULT 8 CHECK (hours_per_day > 0 AND hours_per_day <= 24),
  updated_by     UUID REFERENCES users(id),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE pay_adjustments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id  UUID NOT NULL REFERENCES users(id),
  month        TEXT NOT NULL CHECK (month ~ '^\d{4}-\d{2}$'),
  kind         TEXT NOT NULL CHECK (kind IN ('ADVANCE', 'BONUS', 'ALLOWANCE', 'DEDUCTION')),
  amount       NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  note         TEXT CHECK (length(note) <= 300),
  created_by   UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX pay_adjustments_month_idx ON pay_adjustments (month, employee_id);

CREATE TABLE payroll_runs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organizations(id),
  month        TEXT NOT NULL CHECK (month ~ '^\d{4}-\d{2}$'),
  status       TEXT NOT NULL CHECK (status IN ('APPROVED', 'PAID')),
  total_net    NUMERIC(14,2) NOT NULL,
  employees    INT NOT NULL,
  approved_by  UUID REFERENCES users(id),
  approved_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at      TIMESTAMPTZ,
  UNIQUE (org_id, month)
);

CREATE TABLE payslips (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id       UUID NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  employee_id  UUID NOT NULL REFERENCES users(id),
  month        TEXT NOT NULL,
  net_amount   NUMERIC(12,2) NOT NULL,
  data         JSONB NOT NULL,   -- frozen breakdown: attendance, earnings, deductions
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, employee_id)
);
CREATE INDEX payslips_employee_idx ON payslips (employee_id, month DESC);
