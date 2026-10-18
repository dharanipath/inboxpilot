-- "Remember this browser": one-click sign-in for a returning user, without a trip to Google.
-- Only a SHA-256 of the browser's secret is stored. Rows go with the user (cascade).
CREATE TABLE "remembered_devices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "secret_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "remembered_devices_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "remembered_devices_user_id_idx" ON "remembered_devices"("user_id");
ALTER TABLE "remembered_devices" ADD CONSTRAINT "remembered_devices_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
