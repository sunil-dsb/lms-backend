ALTER TABLE "procedures" ADD COLUMN "is_promo" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "procedures" ADD COLUMN "promo_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "procedures" ADD COLUMN "promo_audience" text DEFAULT 'station' NOT NULL;--> statement-breakpoint
CREATE INDEX "procedures_promo_idx" ON "procedures" USING btree ("is_promo","promo_expires_at");