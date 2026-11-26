CREATE TABLE project_folder_change (
  id INTEGER PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  old_folder TEXT NOT NULL,
  new_folder TEXT NOT NULL,
  changed_at INTEGER NOT NULL
) STRICT;

CREATE TRIGGER project_folder_change_no_update
BEFORE UPDATE ON project_folder_change
BEGIN
  SELECT RAISE(ABORT, 'project folder change is append-only');
END;

CREATE TRIGGER project_folder_change_no_delete
BEFORE DELETE ON project_folder_change
BEGIN
  SELECT RAISE(ABORT, 'project folder change is append-only');
END;

CREATE TRIGGER project_folder_change_no_replace
BEFORE INSERT ON project_folder_change
WHEN EXISTS (SELECT 1 FROM project_folder_change WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'project folder change is append-only');
END;
