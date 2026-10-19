-- Lost-reason tracking on quotes (submissions). Additive, nullable.
-- The worker also adds these on the first lost-status save (ensureLostColumns).
-- Back up D1 (potentia-shed) first: python3 /workspace/backups/d1/d1-backup.py
-- lost_reason: money | competitor | timing | scope | other
-- Rollback: older builds ignore the columns; ALTER TABLE submissions DROP COLUMN <col>;
ALTER TABLE submissions ADD COLUMN lost_reason TEXT;
ALTER TABLE submissions ADD COLUMN lost_note TEXT;
ALTER TABLE submissions ADD COLUMN lost_competitor TEXT;
ALTER TABLE submissions ADD COLUMN lost_at TEXT;
