CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
-- Phase 1 tenant-isolation backstop (option Y). FORCE so the owning role obeys too.
-- current_setting(..., true): unset GUC -> NULL -> no rows (forgotten scope fails safe to empty).
ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "documents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "documents"
  USING ("restaurant_id" = current_setting('app.restaurant_id', true)::uuid)
  WITH CHECK ("restaurant_id" = current_setting('app.restaurant_id', true)::uuid);--> statement-breakpoint
ALTER TABLE "chunks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chunks" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "chunks"
  USING ("restaurant_id" = current_setting('app.restaurant_id', true)::uuid)
  WITH CHECK ("restaurant_id" = current_setting('app.restaurant_id', true)::uuid);--> statement-breakpoint
ALTER TABLE "menu_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "menu_items" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "menu_items"
  USING ("restaurant_id" = current_setting('app.restaurant_id', true)::uuid)
  WITH CHECK ("restaurant_id" = current_setting('app.restaurant_id', true)::uuid);--> statement-breakpoint
ALTER TABLE "modules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "modules" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "modules"
  USING ("restaurant_id" = current_setting('app.restaurant_id', true)::uuid)
  WITH CHECK ("restaurant_id" = current_setting('app.restaurant_id', true)::uuid);--> statement-breakpoint
ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "conversations"
  USING ("restaurant_id" = current_setting('app.restaurant_id', true)::uuid)
  WITH CHECK ("restaurant_id" = current_setting('app.restaurant_id', true)::uuid);--> statement-breakpoint
ALTER TABLE "usage_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "usage_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "usage_events"
  USING ("restaurant_id" = current_setting('app.restaurant_id', true)::uuid)
  WITH CHECK ("restaurant_id" = current_setting('app.restaurant_id', true)::uuid);