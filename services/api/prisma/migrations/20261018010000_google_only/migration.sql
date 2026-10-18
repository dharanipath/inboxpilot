-- Sign-in is Google-only: the demo mode was removed.
DELETE FROM "users" WHERE "auth_mode" = 'demo';
ALTER TABLE "users" DROP CONSTRAINT "users_auth_mode_check";
ALTER TABLE "users" ADD CONSTRAINT "users_auth_mode_check" CHECK ("auth_mode" = 'google');
