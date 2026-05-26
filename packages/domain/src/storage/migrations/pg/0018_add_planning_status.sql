-- Add PLANNING to the task_status enum
-- PLANNING is a mandatory phase before IN-PROGRESS (session_start)
ALTER TYPE "public"."task_status" ADD VALUE IF NOT EXISTS 'PLANNING' BEFORE 'IN-PROGRESS';
