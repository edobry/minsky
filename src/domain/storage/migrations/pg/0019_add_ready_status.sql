-- Add READY to the task_status enum
-- READY is the planning completeness gate before IN-PROGRESS (session_start)
ALTER TYPE "public"."task_status" ADD VALUE IF NOT EXISTS 'READY' BEFORE 'IN-PROGRESS';
