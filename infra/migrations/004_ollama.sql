ALTER TABLE script_versions DROP CONSTRAINT script_versions_provider_check;
ALTER TABLE script_versions ADD CONSTRAINT script_versions_provider_check CHECK (provider IN ('openai', 'anthropic', 'ollama'));
ALTER TABLE script_provider_runs DROP CONSTRAINT script_provider_runs_provider_check;
ALTER TABLE script_provider_runs ADD CONSTRAINT script_provider_runs_provider_check CHECK (provider IN ('openai', 'anthropic', 'ollama'));
