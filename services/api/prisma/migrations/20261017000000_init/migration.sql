-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "name" TEXT,
    "auth_mode" TEXT NOT NULL,
    "refresh_token_enc" BYTEA,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "vip_senders" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "llm_providers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "last_sync_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "emails" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "gmail_id" TEXT NOT NULL,
    "thread_id" TEXT NOT NULL,
    "from_name" TEXT,
    "from_email" TEXT,
    "subject" TEXT,
    "received_at" TIMESTAMPTZ(6) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "skip_reason" TEXT,
    "processed_at" TIMESTAMPTZ(6),

    CONSTRAINT "emails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "email_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "details" TEXT,
    "type" TEXT NOT NULL,
    "due_date" DATE,
    "due_at" TIMESTAMPTZ(6),
    "has_time" BOOLEAN NOT NULL DEFAULT false,
    "due_phrase" TEXT,
    "date_source" TEXT NOT NULL,
    "due_overridden" BOOLEAN NOT NULL DEFAULT false,
    "priority" TEXT NOT NULL,
    "priority_score" SMALLINT NOT NULL,
    "priority_reasons" JSONB NOT NULL,
    "confidence" REAL NOT NULL,
    "evidence" TEXT NOT NULL,
    "extracted_by" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "snoozed_until" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("user_id","id")
);

-- CreateTable
CREATE TABLE "sync_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "days" SMALLINT NOT NULL DEFAULT 14,
    "stats" JSONB,
    "trace" JSONB,
    "provider_usage" JSONB,
    "briefing" JSONB,
    "error" TEXT,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "user_id" UUID,
    "action" TEXT NOT NULL,
    "meta" JSONB,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "emails_user_id_received_at_idx" ON "emails"("user_id", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "emails_user_id_gmail_id_key" ON "emails"("user_id", "gmail_id");

-- CreateIndex
CREATE INDEX "tasks_user_due" ON "tasks"("user_id", "status", "due_date");

-- CreateIndex
CREATE INDEX "sync_runs_user_id_started_at_idx" ON "sync_runs"("user_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "audit_log_at_idx" ON "audit_log"("at");

-- AddForeignKey
ALTER TABLE "emails" ADD CONSTRAINT "emails_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_email_id_fkey" FOREIGN KEY ("email_id") REFERENCES "emails"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Constraints Prisma cannot express ------------------------------------------
ALTER TABLE "users" ADD CONSTRAINT "users_auth_mode_check" CHECK ("auth_mode" IN ('google', 'demo'));
ALTER TABLE "emails" ADD CONSTRAINT "emails_status_check" CHECK ("status" IN ('pending', 'processed', 'skipped', 'failed'));
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_status_check" CHECK ("status" IN ('open', 'done', 'snoozed', 'dismissed'));
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_priority_check" CHECK ("priority" IN ('P0', 'P1', 'P2', 'P3'));
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_date_source_check" CHECK ("date_source" IN ('resolver', 'llm', 'none', 'user'));
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_confidence_check" CHECK ("confidence" >= 0 AND "confidence" <= 1);
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_status_check" CHECK ("status" IN ('queued', 'running', 'succeeded', 'failed'));
