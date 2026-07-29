CREATE TABLE "reviewer_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pr_owner" text NOT NULL,
	"pr_repo" text NOT NULL,
	"pr_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"round" integer NOT NULL,
	"severity" text NOT NULL,
	"file" text NOT NULL,
	"line" integer,
	"line_end" integer,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"disposition" text,
	"disposition_set_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_rf_pr_round" ON "reviewer_findings" USING btree ("pr_owner","pr_repo","pr_number","round");--> statement-breakpoint
CREATE INDEX "idx_rf_created_at" ON "reviewer_findings" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_rf_disposition" ON "reviewer_findings" USING btree ("disposition");--> statement-breakpoint
CREATE INDEX "idx_rf_severity" ON "reviewer_findings" USING btree ("severity");