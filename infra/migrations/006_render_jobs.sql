ALTER TABLE jobs DROP CONSTRAINT jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check CHECK (kind IN ('system_check', 'generate_script', 'import_url', 'render_video'));
CREATE TABLE video_renders (
  job_id uuid PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id),
  script_id uuid NOT NULL REFERENCES script_versions(id),
  source_id uuid NOT NULL REFERENCES sources(id),
  voice_key text,
  video_key text,
  metadata_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((video_key IS NULL) = (metadata_json IS NULL))
);
