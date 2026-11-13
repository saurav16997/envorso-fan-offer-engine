CREATE TABLE copy_generations (
  tenant_id TEXT NOT NULL, scenario_id TEXT NOT NULL, generation_id TEXT NOT NULL,
  opportunity_key TEXT NOT NULL, revision_id TEXT NOT NULL, channel TEXT NOT NULL, offer_kind TEXT NOT NULL,
  model TEXT NOT NULL, prompt_version TEXT NOT NULL, provider TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','suggested','unavailable','timeout','refused','incomplete','invalid','error','stale')),
  wording_json TEXT, started_at TEXT NOT NULL, finished_at TEXT,
  PRIMARY KEY (tenant_id, scenario_id, generation_id),
  FOREIGN KEY (tenant_id, scenario_id, revision_id) REFERENCES revisions ON DELETE CASCADE
) STRICT;
CREATE INDEX copy_request_scope ON copy_generations(tenant_id, scenario_id, started_at);
CREATE TABLE copy_revision_provenance (
  tenant_id TEXT NOT NULL, scenario_id TEXT NOT NULL, revision_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('ai_assisted','marketer_edited')),
  generation_id TEXT,
  PRIMARY KEY (tenant_id, scenario_id, revision_id),
  FOREIGN KEY (tenant_id, scenario_id, revision_id) REFERENCES revisions ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, scenario_id, generation_id) REFERENCES copy_generations ON DELETE CASCADE
) STRICT;
CREATE TRIGGER copy_provenance_immutable BEFORE UPDATE ON copy_revision_provenance BEGIN
  SELECT RAISE(ABORT, 'Saved copy provenance is immutable');
END;
