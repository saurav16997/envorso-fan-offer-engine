CREATE TABLE scenarios (
  tenant_id TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  input_json TEXT NOT NULL,
  evaluation_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, scenario_id)
) STRICT;

CREATE TABLE opportunities (
  tenant_id TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  opportunity_key TEXT NOT NULL,
  current_revision_id TEXT,
  approved_revision_id TEXT,
  review_status TEXT NOT NULL CHECK(review_status IN ('draft', 'approved', 'rejected')),
  version INTEGER NOT NULL,
  basis_hash TEXT NOT NULL,
  PRIMARY KEY (tenant_id, scenario_id, opportunity_key),
  FOREIGN KEY (tenant_id, scenario_id) REFERENCES scenarios ON DELETE CASCADE
) STRICT;

CREATE TABLE revisions (
  tenant_id TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  opportunity_key TEXT NOT NULL,
  revision_number INTEGER NOT NULL,
  basis_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  PRIMARY KEY (tenant_id, scenario_id, revision_id),
  UNIQUE (tenant_id, scenario_id, opportunity_key, revision_number),
  FOREIGN KEY (tenant_id, scenario_id, opportunity_key) REFERENCES opportunities ON DELETE CASCADE
) STRICT;

CREATE TABLE source_associations (
  tenant_id TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  opportunity_key TEXT NOT NULL,
  cart_id TEXT NOT NULL,
  observation_json TEXT NOT NULL,
  PRIMARY KEY (tenant_id, scenario_id, opportunity_key, cart_id),
  FOREIGN KEY (tenant_id, scenario_id, opportunity_key) REFERENCES opportunities ON DELETE CASCADE
) STRICT;

CREATE TABLE review_decisions (
  tenant_id TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  opportunity_key TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('approve', 'reject')),
  actor_id TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  reason TEXT,
  payload_hash TEXT NOT NULL,
  PRIMARY KEY (tenant_id, scenario_id, decision_id),
  UNIQUE (tenant_id, scenario_id, revision_id, kind),
  FOREIGN KEY (tenant_id, scenario_id, revision_id) REFERENCES revisions ON DELETE CASCADE
) STRICT;

CREATE TABLE audit_events (
  tenant_id TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  opportunity_key TEXT,
  revision_id TEXT,
  actor_id TEXT NOT NULL,
  event_at TEXT NOT NULL,
  kind TEXT NOT NULL,
  description TEXT NOT NULL,
  PRIMARY KEY (tenant_id, scenario_id, event_id),
  FOREIGN KEY (tenant_id, scenario_id) REFERENCES scenarios ON DELETE CASCADE
) STRICT;

CREATE TRIGGER revisions_immutable BEFORE UPDATE ON revisions BEGIN
  SELECT RAISE(ABORT, 'Proposal revisions are immutable');
END;
CREATE TRIGGER decisions_immutable BEFORE UPDATE ON review_decisions BEGIN
  SELECT RAISE(ABORT, 'Review decisions are immutable');
END;
CREATE TRIGGER audit_immutable BEFORE UPDATE ON audit_events BEGIN
  SELECT RAISE(ABORT, 'Audit events are immutable');
END;
