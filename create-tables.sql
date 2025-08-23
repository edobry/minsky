-- Create the tables needed for the minsky backend
CREATE TYPE "public"."task_status" AS ENUM('TODO', 'IN-PROGRESS', 'IN-REVIEW', 'DONE', 'BLOCKED', 'CLOSED');
CREATE TYPE "public"."task_backend" AS ENUM('markdown', 'json-file', 'github-issues', 'database', 'minsky');

-- Tasks table (metadata only)
CREATE TABLE "public"."tasks" (
    "id" text PRIMARY KEY,
    "source_task_id" text,
    "backend" "task_backend",
    "status" "task_status",
    "title" text,
    "last_indexed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT now(),
    "updated_at" timestamp with time zone DEFAULT now()
);

-- Task specs table (content)
CREATE TABLE "public"."task_specs" (
    "task_id" text PRIMARY KEY,
    "content" text NOT NULL,
    "version" integer DEFAULT 1,
    "created_at" timestamp with time zone DEFAULT now(),
    "updated_at" timestamp with time zone DEFAULT now()
);

-- Example: Insert some test mt# tasks
INSERT INTO "public"."tasks" ("id", "source_task_id", "backend", "status", "title", "created_at") VALUES
('mt#001', '001', 'minsky', 'TODO', 'Test Minsky Task 1', now()),
('mt#002', '002', 'minsky', 'IN-PROGRESS', 'Test Minsky Task 2', now()),
('mt#100', '100', 'minsky', 'DONE', 'Align MCP API with CLI Implementation and Remove Placeholders', now()),
('mt#200', '200', 'minsky', 'TODO', 'Another Test Minsky Task', now());

INSERT INTO "public"."task_specs" ("task_id", "content") VALUES
('mt#001', '# Test Minsky Task 1\n\nThis is a test task in the minsky backend.'),
('mt#002', '# Test Minsky Task 2\n\nThis is another test task.'),
('mt#100', '# Align MCP API with CLI Implementation and Remove Placeholders\n\nAlign the MCP API implementation with CLI patterns.'),
('mt#200', '# Another Test Minsky Task\n\nYet another test task in the database.');
