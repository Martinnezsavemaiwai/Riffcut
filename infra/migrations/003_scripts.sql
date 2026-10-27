ALTER TABLE jobs DROP CONSTRAINT jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check CHECK (kind IN ('system_check', 'generate_script'));
CREATE TABLE knowledge_packs (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  source_id uuid NOT NULL REFERENCES sources(id),
  version integer NOT NULL CHECK (version > 0),
  pack_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, version)
);
CREATE INDEX knowledge_packs_project_idx ON knowledge_packs (project_id, created_at);
CREATE TABLE script_versions (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  knowledge_pack_id uuid NOT NULL REFERENCES knowledge_packs(id),
  version integer NOT NULL CHECK (version > 0),
  parent_id uuid REFERENCES script_versions(id),
  generation_job_id uuid UNIQUE REFERENCES jobs(id),
  target_duration_seconds integer NOT NULL CHECK (target_duration_seconds IN (30, 60, 90)),
  origin text NOT NULL CHECK (origin IN ('generated', 'manual')),
  provider text CHECK (provider IN ('openai', 'anthropic')),
  model text,
  body_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, version)
);
CREATE TABLE script_provider_runs (
  job_id uuid PRIMARY KEY REFERENCES jobs(id),
  provider text NOT NULL CHECK (provider IN ('openai', 'anthropic')),
  model text NOT NULL,
  status text NOT NULL CHECK (status IN ('calling', 'succeeded', 'failed')),
  result_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
