ALTER TABLE handoff ADD COLUMN active_run_id TEXT REFERENCES run(id);
UPDATE handoff SET active_run_id = (
  SELECT id FROM run WHERE handoff_id = handoff.id
  ORDER BY (state IN ('Starting', 'Running')) DESC, rowid DESC LIMIT 1
);

ALTER TABLE run ADD COLUMN superseded_by TEXT REFERENCES run(id);
ALTER TABLE run ADD COLUMN workspace TEXT;
ALTER TABLE run ADD COLUMN stop_requested_event_id INTEGER REFERENCES event(id);
ALTER TABLE run ADD COLUMN stop_state TEXT CHECK (stop_state IN ('pending', 'unresolved', 'verified'));

ALTER TABLE event ADD COLUMN run_id TEXT REFERENCES run(id);
CREATE INDEX event_by_run ON event(run_id, kind);
ALTER TABLE delivery ADD COLUMN skip_reason TEXT;
DROP INDEX dispatch_per_handoff;
CREATE UNIQUE INDEX dispatch_per_handoff ON delivery(handoff_id)
  WHERE in_flight = 1 AND skip_reason IS NULL;
