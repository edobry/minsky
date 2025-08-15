CREATE TABLE "sessions" (
	"session" varchar(255) PRIMARY KEY NOT NULL,
	"repo_name" varchar(255) NOT NULL,
	"repo_url" varchar(1000) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"task_id" varchar(100),
	"pr_branch" varchar(255),
	"pr_approved" varchar(10),
	"pr_state" text,
	"backend_type" varchar(50),
	"pull_request" text
);
