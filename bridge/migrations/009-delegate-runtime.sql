CREATE TABLE delegate_runtime (
  run_id TEXT PRIMARY KEY REFERENCES delegate_launch(run_id),
  state TEXT NOT NULL CHECK (state IN ('unknown', 'failed', 'completed')),
  reason TEXT,
  result_text TEXT
) STRICT;

ALTER TABLE question ADD COLUMN pull_turn_id TEXT REFERENCES turn(id);
ALTER TABLE question ADD COLUMN pull_question_count INTEGER CHECK (pull_question_count > 0);
ALTER TABLE question ADD COLUMN pull_response_state TEXT CHECK (pull_response_state IN ('claimed', 'request-closed', 'unverified'));

CREATE TABLE claude_project_connection (
  project_id TEXT PRIMARY KEY REFERENCES project_registration(project_id),
  manifest TEXT NOT NULL,
  applied INTEGER NOT NULL DEFAULT 0 CHECK (applied IN (0, 1))
) STRICT;

CREATE TABLE codex_request_refusal (
  id INTEGER PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES connection(id),
  occurred_at INTEGER NOT NULL,
  reason TEXT NOT NULL
) STRICT;
