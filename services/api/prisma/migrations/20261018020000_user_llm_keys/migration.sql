-- Users can bring their own free-tier LLM API keys (ADR 0006).
-- One AES-256-GCM blob per user (iv|tag|ciphertext of {"provider": "key"}), bound to the user id.
ALTER TABLE "users" ADD COLUMN "llm_keys_enc" BYTEA;
