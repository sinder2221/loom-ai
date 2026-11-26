ALTER TABLE handoff ADD COLUMN title TEXT NOT NULL DEFAULT 'Untitled handoff';

CREATE TABLE delegate_project (
  project_id TEXT PRIMARY KEY NOT NULL REFERENCES project(id),
  folder TEXT NOT NULL,
  destination_chat_id TEXT NOT NULL REFERENCES chat_reference(id),
  default_model TEXT NOT NULL
) STRICT;

CREATE TABLE delegate_launch (
  handoff_id TEXT PRIMARY KEY NOT NULL REFERENCES handoff(id),
  run_id TEXT NOT NULL UNIQUE,
  project_folder TEXT NOT NULL,
  cwd TEXT NOT NULL,
  destination_chat_id TEXT NOT NULL REFERENCES chat_reference(id),
  model TEXT NOT NULL
) STRICT;

CREATE TRIGGER delegate_launch_prevent_existing
BEFORE INSERT ON delegate_launch
WHEN EXISTS (SELECT 1 FROM run WHERE handoff_id = NEW.handoff_id)
  OR EXISTS (SELECT 1 FROM approval WHERE handoff_id = NEW.handoff_id
             AND kind = 'launch' AND consumed_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'handoff already has a launch');
END;

