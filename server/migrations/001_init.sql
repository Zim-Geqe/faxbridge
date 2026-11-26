CREATE TABLE orgs (
  id text PRIMARY KEY,
  name text NOT NULL
);

CREATE TABLE users (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  role text NOT NULL CHECK (role IN ('sender','approver','admin')),
  password_hash text NOT NULL
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL
);

CREATE TABLE documents (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  created_by text NOT NULL REFERENCES users(id),
  approver_id text REFERENCES users(id),
  filename text NOT NULL,
  mime text NOT NULL,
  size integer NOT NULL,
  sha256 text NOT NULL,
  blob_key text NOT NULL,
  status text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  locked_until timestamptz,
  recipient_name text NOT NULL,
  recipient_address text NOT NULL,
  requires_approval boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX documents_org_idx ON documents(org_id, created_at DESC);
CREATE INDEX documents_claim_idx ON documents(status, locked_until);

CREATE TABLE extractions (
  document_id text PRIMARY KEY REFERENCES documents(id),
  provider text NOT NULL,
  raw_text text NOT NULL,
  fields jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE approvals (
  document_id text PRIMARY KEY REFERENCES documents(id),
  decided_by text NOT NULL REFERENCES users(id),
  decision text NOT NULL CHECK (decision IN ('approved','rejected')),
  reason text,
  idempotency_key text,
  decided_at timestamptz NOT NULL
);

CREATE TABLE inbox_items (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id),
  type text NOT NULL,
  document_id text NOT NULL REFERENCES documents(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resolved')),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  resolved_at timestamptz
);
CREATE INDEX inbox_user_idx ON inbox_items(user_id, status);

CREATE TABLE deliveries (
  id text PRIMARY KEY,
  document_id text NOT NULL REFERENCES documents(id),
  status text NOT NULL CHECK (status IN ('queued','sending','retry','accepted','delivered','failed','cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 6,
  next_attempt_at timestamptz NOT NULL,
  locked_until timestamptz,
  provider text NOT NULL,
  simulated boolean NOT NULL,
  provider_ref text,
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL
);
CREATE INDEX deliveries_claim_idx ON deliveries(status, next_attempt_at);

CREATE TABLE delivery_attempts (
  id text PRIMARY KEY,
  delivery_id text NOT NULL REFERENCES deliveries(id),
  attempt integer NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  outcome text,
  error text
);

CREATE TABLE audit_events (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  document_id text NOT NULL REFERENCES documents(id),
  seq integer NOT NULL,
  type text NOT NULL,
  actor_id text,
  data jsonb NOT NULL,
  prev_hash text NOT NULL,
  hash text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (document_id, seq)
);
