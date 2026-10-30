-- Emails with a real file attachment (set during sync from the Gmail message parts).
ALTER TABLE "emails" ADD COLUMN "has_attachment" BOOLEAN NOT NULL DEFAULT false;
