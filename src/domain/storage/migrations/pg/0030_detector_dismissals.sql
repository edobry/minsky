-- Add detector_dismissals table — per-project dismissed evidence signatures.
-- mt#1035 §Calibration and dismissal §1 Dismiss-and-remember.
--
-- A row records that the operator dismissed a detection with the given
-- evidence signature in the given repo_url project. Scoped per-project;
-- no cross-project transfer per mt#1035 §Open questions.
--
-- Backout:
--   DROP INDEX IF EXISTS idx_detector_dismissals_sig_repo;
--   DROP TABLE IF EXISTS detector_dismissals;

CREATE TABLE IF NOT EXISTS "detector_dismissals" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "signature"  text NOT NULL,
  "repo_url"   text NOT NULL,
  "response"   text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_detector_dismissals_sig_repo"
  ON "detector_dismissals" ("signature", "repo_url");
