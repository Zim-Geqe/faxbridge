CREATE TABLE devices (
  id text PRIMARY KEY,                       -- app-generated installation id
  user_id text NOT NULL REFERENCES users(id),
  token text NOT NULL,
  platform text NOT NULL,
  app_version text,
  permission text NOT NULL DEFAULT 'unknown' CHECK (permission IN ('granted','denied','unknown')),
  token_status text NOT NULL DEFAULT 'active' CHECK (token_status IN ('active','invalid')),
  last_seen_at timestamptz NOT NULL,
  last_push_accepted_at timestamptz,
  last_ack_at timestamptz,
  created_at timestamptz NOT NULL
);
CREATE INDEX devices_user_idx ON devices(user_id);
CREATE UNIQUE INDEX devices_active_token_idx ON devices(token) WHERE token_status = 'active';

CREATE TABLE notifications_outbox (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id),
  device_id text NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  inbox_item_id text REFERENCES inbox_items(id),
  kind text NOT NULL CHECK (kind IN ('approval_request','delivery_failed','resolved','test')),
  dedupe_key text NOT NULL UNIQUE,
  priority text NOT NULL CHECK (priority IN ('high','normal')),
  status text NOT NULL CHECK (status IN ('pending','sending','retry','accepted','failed','token_invalid','skipped_no_permission','skipped_resolved','expired')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  locked_until timestamptz,
  last_error text,
  fcm_message_id text,
  accepted_at timestamptz,
  device_ack_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX outbox_claim_idx ON notifications_outbox(status, next_attempt_at);
CREATE INDEX outbox_device_idx ON notifications_outbox(device_id, created_at DESC);
