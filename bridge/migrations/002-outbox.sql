CREATE TABLE delivery (
  id INTEGER PRIMARY KEY,
  handoff_id TEXT NOT NULL,
  event_id INTEGER NOT NULL,
  destination_chat_id TEXT NOT NULL REFERENCES chat_reference(id),
  correlation_id TEXT NOT NULL UNIQUE CHECK (length(correlation_id) > 0),
  state TEXT NOT NULL DEFAULT 'Queued' CHECK (state IN (
    'Queued', 'Accepted by transport', 'Held for approval',
    'Delivered to chat', 'Refused', 'Needs verification'
  )),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  in_flight INTEGER NOT NULL DEFAULT 0 CHECK (in_flight IN (0, 1)),
  deadline_at INTEGER,
  last_error TEXT,
  UNIQUE (event_id, destination_chat_id),
  UNIQUE (id, destination_chat_id, correlation_id),
  FOREIGN KEY (handoff_id, event_id) REFERENCES event(handoff_id, id),
  CHECK (in_flight = 0 OR (attempts > 0 AND deadline_at IS NOT NULL AND state IN (
    'Queued', 'Accepted by transport', 'Held for approval'
  )))
) STRICT;

CREATE UNIQUE INDEX dispatch_per_handoff ON delivery(handoff_id) WHERE in_flight = 1;
CREATE UNIQUE INDEX dispatch_per_chat ON delivery(destination_chat_id) WHERE in_flight = 1;
CREATE INDEX pending_deliveries ON delivery(id) WHERE state = 'Queued' AND in_flight = 0;

ALTER TABLE event ADD COLUMN delivery_id INTEGER REFERENCES delivery(id);

CREATE TABLE receipt (
  delivery_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('Received', 'Acted')),
  destination_chat_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  event_id INTEGER NOT NULL UNIQUE REFERENCES event(id),
  evidence TEXT NOT NULL CHECK (length(evidence) > 0),
  late INTEGER NOT NULL CHECK (late IN (0, 1)),
  PRIMARY KEY (delivery_id, kind),
  FOREIGN KEY (delivery_id, destination_chat_id, correlation_id)
    REFERENCES delivery(id, destination_chat_id, correlation_id)
) STRICT;

CREATE TRIGGER require_received_on_insert
BEFORE INSERT ON delivery
WHEN NEW.state = 'Delivered to chat'
BEGIN
  SELECT RAISE(ABORT, 'Delivery requires a Received receipt');
END;

CREATE TRIGGER require_received_on_update
BEFORE UPDATE OF state ON delivery
WHEN NEW.state = 'Delivered to chat' AND NOT EXISTS (
  SELECT 1 FROM receipt WHERE delivery_id = NEW.id AND kind = 'Received'
)
BEGIN
  SELECT RAISE(ABORT, 'Delivery requires a Received receipt');
END;

CREATE TRIGGER protect_received_on_delete
BEFORE DELETE ON receipt
WHEN OLD.kind = 'Received' AND EXISTS (
  SELECT 1 FROM delivery WHERE id = OLD.delivery_id AND state = 'Delivered to chat'
)
BEGIN
  SELECT RAISE(ABORT, 'Delivery requires a Received receipt');
END;

CREATE TRIGGER protect_receipt_identity
BEFORE UPDATE OF delivery_id, kind ON receipt
WHEN OLD.delivery_id <> NEW.delivery_id OR OLD.kind <> NEW.kind
BEGIN
  SELECT RAISE(ABORT, 'Receipt identity is immutable');
END;
