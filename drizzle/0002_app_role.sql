-- Phase 1 (revision): the app must connect as a NON-superuser, or RLS is bypassed.
-- The default `reg` role is a SUPERUSER and bypasses RLS even with FORCE. So we add a
-- dedicated NOSUPERUSER role `reg_app`: the app connects as reg_app (RLS applies),
-- while migrations keep using reg. Role creation lives in this migration (not a docker
-- init script) because the DB volume is already initialized; the IF NOT EXISTS guard
-- keeps it idempotent on a fresh cluster.
-- NOTE: 'reg_app_dev_pw' is a DEV-ONLY password. Prod provisions reg_app + its secret
-- via infra (Phase 8), not via this committed migration.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'reg_app') THEN
    CREATE ROLE reg_app LOGIN PASSWORD 'reg_app_dev_pw';
  END IF;
END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO reg_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO reg_app;--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO reg_app;--> statement-breakpoint
-- Tables/sequences created by reg in later migrations auto-grant to reg_app.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO reg_app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO reg_app;
