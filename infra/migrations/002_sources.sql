CREATE TABLE sources (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  status text NOT NULL CHECK (status IN ('uploading', 'ready', 'failed')),
  original_filename text NOT NULL CHECK (length(original_filename) BETWEEN 1 AND 200),
  metadata_json jsonb NOT NULL,
  error_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sources_project_idx ON sources (project_id, created_at);
CREATE TABLE assets (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL UNIQUE REFERENCES sources(id),
  object_key text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind = 'source_video'),
  status text NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
  content_type text NOT NULL CHECK (content_type = 'video/mp4'),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 262144000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE rights_records (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL UNIQUE REFERENCES sources(id),
  basis text NOT NULL CHECK (basis IN ('owner', 'licensed', 'permission')),
  notes text NOT NULL CHECK (length(trim(notes)) BETWEEN 1 AND 1000),
  attested_at timestamptz NOT NULL DEFAULT now()
);
