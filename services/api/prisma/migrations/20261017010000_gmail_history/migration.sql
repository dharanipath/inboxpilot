-- Incremental Gmail sync checkpoint (users.history.list)
ALTER TABLE "users" ADD COLUMN "gmail_history_id" TEXT;
