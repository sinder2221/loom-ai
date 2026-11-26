CREATE TABLE approval_origin (
  chat_id TEXT PRIMARY KEY NOT NULL REFERENCES chat_reference(id),
  credential_hash TEXT NOT NULL UNIQUE
) STRICT;

CREATE TABLE approval (
  token_hash TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('launch', 'answer', 'approval')),
  project_id TEXT NOT NULL REFERENCES project(id),
  connection_id TEXT NOT NULL REFERENCES connection(id),
  origin_chat_id TEXT NOT NULL REFERENCES chat_reference(id),
  handoff_id TEXT NOT NULL REFERENCES handoff(id),
  run_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  launch_plan TEXT CHECK (json_valid(launch_plan)),
  launch_folder TEXT,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  CHECK ((kind = 'launch') = (launch_plan IS NOT NULL)),
  CHECK ((kind = 'launch' AND consumed_at IS NOT NULL) = (launch_folder IS NOT NULL))
) STRICT;

CREATE UNIQUE INDEX authorized_launch_per_handoff ON approval(handoff_id)
  WHERE kind = 'launch' AND consumed_at IS NOT NULL;
CREATE UNIQUE INDEX authorized_launch_per_run ON approval(run_id)
  WHERE kind = 'launch' AND consumed_at IS NOT NULL;

-- A refusal without an established handoff can still be recorded without keeping caller input.
CREATE TABLE unbound_authorization_refusal (
  id INTEGER PRIMARY KEY,
  occurred_at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  reason TEXT NOT NULL
) STRICT;
