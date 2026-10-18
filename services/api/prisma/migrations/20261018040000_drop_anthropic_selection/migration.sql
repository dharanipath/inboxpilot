-- Anthropic Claude support was removed (free models only). Anyone who had picked it falls back
-- to the automatic order instead of being left on a model that no longer exists.
UPDATE "users" SET "llm_providers" = '{}' WHERE 'anthropic' = ANY("llm_providers");
