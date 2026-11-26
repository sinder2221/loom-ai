CREATE TABLE project (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL
) STRICT;

CREATE TABLE connection (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES project(id),
  provider TEXT NOT NULL,
  account_ref TEXT NOT NULL,
  UNIQUE (project_id, provider, account_ref)
) STRICT;

CREATE TABLE chat_reference (
  id TEXT PRIMARY KEY NOT NULL,
  connection_id TEXT NOT NULL REFERENCES connection(id),
  session_ref TEXT NOT NULL,
  UNIQUE (connection_id, session_ref)
) STRICT;

CREATE TABLE handoff (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES project(id),
  origin_chat_id TEXT NOT NULL REFERENCES chat_reference(id),
  brief TEXT NOT NULL,
  automatic_turns INTEGER NOT NULL DEFAULT 0 CHECK (automatic_turns >= 0),
  automatic_turn_limit INTEGER NOT NULL CHECK (automatic_turn_limit > 0)
) STRICT;

CREATE TABLE run (
  id TEXT PRIMARY KEY NOT NULL,
  handoff_id TEXT NOT NULL REFERENCES handoff(id),
  destination_chat_id TEXT NOT NULL REFERENCES chat_reference(id),
  model TEXT NOT NULL,
  permissions TEXT NOT NULL CHECK (json_valid(permissions)),
  state TEXT NOT NULL CHECK (state IN ('Starting', 'Running', 'Completed', 'Interrupted')),
  reason TEXT,
  UNIQUE (handoff_id, id)
) STRICT;

CREATE UNIQUE INDEX active_run_per_handoff ON run(handoff_id)
  WHERE state IN ('Starting', 'Running');
CREATE UNIQUE INDEX launch_per_chat ON run(destination_chat_id) WHERE state = 'Starting';

CREATE TABLE turn (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES run(id),
  state TEXT NOT NULL CHECK (state IN ('In flight', 'Completed', 'Interrupted')),
  reason TEXT
) STRICT;

CREATE UNIQUE INDEX active_turn_per_run ON turn(run_id) WHERE state = 'In flight';

CREATE TABLE question (
  handoff_id TEXT NOT NULL,
  id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  nonce_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  opened_event_id INTEGER NOT NULL UNIQUE REFERENCES event(id),
  answer_event_id INTEGER UNIQUE REFERENCES event(id),
  reply_event_id INTEGER UNIQUE REFERENCES event(id),
  PRIMARY KEY (handoff_id, id),
  FOREIGN KEY (handoff_id, run_id) REFERENCES run(handoff_id, id)
) STRICT;

CREATE TABLE event (
  id INTEGER PRIMARY KEY,
  handoff_id TEXT NOT NULL REFERENCES handoff(id),
  actor TEXT NOT NULL,
  scope TEXT NOT NULL,
  source TEXT NOT NULL,
  source_id TEXT,
  kind TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  correlation_id TEXT,
  subject_id TEXT,
  destination_chat_id TEXT REFERENCES chat_reference(id),
  from_state TEXT,
  to_state TEXT,
  attempt INTEGER,
  outcome TEXT NOT NULL,
  reason TEXT,
  payload TEXT CHECK (json_valid(payload)),
  UNIQUE (source, source_id),
  UNIQUE (handoff_id, id)
) STRICT;

CREATE INDEX event_by_handoff ON event(handoff_id, id);
