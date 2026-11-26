CREATE TABLE project_registration (
  project_id TEXT PRIMARY KEY NOT NULL REFERENCES project(id),
  folder TEXT NOT NULL UNIQUE,
  registered_at INTEGER NOT NULL
) STRICT;
