-- mt#2311: collapse task workflows to a single success terminal (DONE).
-- Migrates rows at the retired COMPLETED status (umbrella/state-ops success
-- terminal from mt#1812) to DONE. The task_status Postgres enum keeps the
-- COMPLETED value — PG cannot drop enum values — so it remains as a harmless
-- orphan that application code no longer reads or writes.
UPDATE tasks SET status = 'DONE', updated_at = now() WHERE status = 'COMPLETED';