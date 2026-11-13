CREATE TABLE dispatches (
  tenant_id TEXT NOT NULL, scenario_id TEXT NOT NULL, dispatch_id TEXT NOT NULL,
  subject_key TEXT NOT NULL, match_id TEXT NOT NULL, opportunity_key TEXT NOT NULL,
  binding_id TEXT, state TEXT NOT NULL CHECK(state IN ('queued','in_progress','accepted','failed','unknown','blocked')),
  explanation TEXT NOT NULL, next_check_at TEXT, claim_token TEXT, lease_until TEXT,
  provider_reference TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, scenario_id, dispatch_id),
  UNIQUE (tenant_id, scenario_id, subject_key, match_id),
  FOREIGN KEY (tenant_id, scenario_id) REFERENCES scenarios ON DELETE CASCADE
) STRICT;
CREATE TABLE dispatch_bindings (
  tenant_id TEXT NOT NULL, scenario_id TEXT NOT NULL, binding_id TEXT NOT NULL,
  dispatch_id TEXT NOT NULL, revision_id TEXT NOT NULL, payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL, idempotency_key TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, scenario_id, binding_id),
  UNIQUE (tenant_id, scenario_id, revision_id), UNIQUE (tenant_id, scenario_id, idempotency_key),
  FOREIGN KEY (tenant_id, scenario_id, dispatch_id) REFERENCES dispatches ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, scenario_id, revision_id) REFERENCES revisions ON DELETE CASCADE
) STRICT;
CREATE TABLE dispatch_attempts (
  tenant_id TEXT NOT NULL, scenario_id TEXT NOT NULL, attempt_id TEXT NOT NULL, dispatch_id TEXT NOT NULL,
  binding_id TEXT NOT NULL, attempt_number INTEGER NOT NULL, state TEXT NOT NULL,
  started_at TEXT NOT NULL, evaluation_at TEXT NOT NULL, call_started INTEGER NOT NULL DEFAULT 0 CHECK(call_started IN (0,1)),
  mode TEXT NOT NULL CHECK(mode IN ('accepted','rejected','accepted_timeout','unknown_timeout')),
  provider_reference TEXT, explanation TEXT NOT NULL,
  PRIMARY KEY (tenant_id, scenario_id, attempt_id),
  UNIQUE (tenant_id, scenario_id, dispatch_id, attempt_number),
  FOREIGN KEY (tenant_id, scenario_id, dispatch_id) REFERENCES dispatches ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, scenario_id, binding_id) REFERENCES dispatch_bindings ON DELETE CASCADE
) STRICT;
CREATE TABLE simulator_settings (
  tenant_id TEXT NOT NULL, scenario_id TEXT NOT NULL, mode TEXT NOT NULL,
  PRIMARY KEY (tenant_id, scenario_id), FOREIGN KEY (tenant_id, scenario_id) REFERENCES scenarios ON DELETE CASCADE
) STRICT;
CREATE TABLE simulated_provider_requests (
  tenant_id TEXT NOT NULL, scenario_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL, mode TEXT NOT NULL, provider_reference TEXT,
  lookup_supported INTEGER NOT NULL CHECK(lookup_supported IN (0,1)), submissions INTEGER NOT NULL,
  evaluation_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, scenario_id, idempotency_key),
  FOREIGN KEY (tenant_id, scenario_id) REFERENCES scenarios ON DELETE CASCADE
) STRICT;
CREATE TABLE promos (
  tenant_id TEXT NOT NULL, scenario_id TEXT NOT NULL, code TEXT NOT NULL, opportunity_key TEXT NOT NULL,
  terms_hash TEXT NOT NULL, subject_key TEXT NOT NULL, match_id TEXT NOT NULL, section TEXT NOT NULL, seats INTEGER NOT NULL,
  percent INTEGER NOT NULL CHECK(percent BETWEEN 1 AND 15), subtotal_cents INTEGER NOT NULL CHECK(subtotal_cents >= 0),
  maximum_discount_cents INTEGER NOT NULL CHECK(maximum_discount_cents >= 0), expires_at TEXT NOT NULL,
  approved_revision_id TEXT, state TEXT NOT NULL CHECK(state IN ('reserved','active','redeemed','cancelled')),
  PRIMARY KEY (tenant_id, scenario_id, code), UNIQUE (tenant_id, scenario_id, opportunity_key, terms_hash),
  FOREIGN KEY (tenant_id, scenario_id, opportunity_key) REFERENCES opportunities ON DELETE CASCADE
) STRICT;
CREATE TABLE simulated_purchases (
  tenant_id TEXT NOT NULL, scenario_id TEXT NOT NULL, purchase_id TEXT NOT NULL, code TEXT NOT NULL,
  subject_key TEXT NOT NULL, match_id TEXT NOT NULL, subtotal_cents INTEGER NOT NULL, discount_cents INTEGER NOT NULL,
  paid_cents INTEGER NOT NULL, evaluation_at TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, scenario_id, purchase_id), UNIQUE (tenant_id, scenario_id, code),
  FOREIGN KEY (tenant_id, scenario_id, code) REFERENCES promos ON DELETE CASCADE
) STRICT;
CREATE TRIGGER dispatch_bindings_immutable BEFORE UPDATE ON dispatch_bindings BEGIN
  SELECT RAISE(ABORT, 'Dispatch snapshots are immutable');
END;
CREATE TRIGGER purchase_immutable BEFORE UPDATE ON simulated_purchases BEGIN
  SELECT RAISE(ABORT, 'Simulated purchases are immutable');
END;
