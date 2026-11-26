CREATE TABLE capture_consent (
  project_id TEXT NOT NULL REFERENCES project(id),
  connection_id TEXT NOT NULL REFERENCES connection(id),
  granted INTEGER NOT NULL CHECK (granted IN (0, 1)),
  generation INTEGER NOT NULL CHECK (generation > 0),
  changed_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, connection_id)
) STRICT;

CREATE TABLE source_link (
  id INTEGER PRIMARY KEY,
  handoff_id TEXT NOT NULL REFERENCES handoff(id),
  source_chat_id TEXT NOT NULL REFERENCES chat_reference(id),
  item_ref TEXT NOT NULL,
  deleted_at INTEGER,
  UNIQUE (handoff_id, source_chat_id, item_ref)
) STRICT;

CREATE TABLE captured_delivery (
  delivery_id INTEGER PRIMARY KEY REFERENCES delivery(id),
  source_link_id INTEGER NOT NULL REFERENCES source_link(id),
  consent_generation INTEGER NOT NULL CHECK (consent_generation > 0)
) STRICT;
