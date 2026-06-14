ALTER TABLE "modules" ALTER COLUMN "content" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "module_progress" ADD COLUMN "restaurant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "modules" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "module_progress" ADD CONSTRAINT "module_progress_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "module_progress_restaurant_idx" ON "module_progress" USING btree ("restaurant_id");--> statement-breakpoint
ALTER TABLE "module_progress" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "module_progress" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "module_progress"
  USING      ("restaurant_id" = current_setting('app.restaurant_id', true)::uuid)
  WITH CHECK ("restaurant_id" = current_setting('app.restaurant_id', true)::uuid);
