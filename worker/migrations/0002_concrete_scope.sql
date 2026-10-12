-- Concrete scope of work: free-text details of the concrete job, per order.
--
-- Additive and optional. The worker also adds it on the first save from the
-- CRM (ensureConcreteScopeColumn), so running this by hand is only needed to
-- have the column before anyone saves. Back up D1 (potentia-shed) first.
--
-- Nullable, no default: every existing order has no scope, and shows none.
-- Rollback: older worker builds ignore the column; to drop it,
--   ALTER TABLE submissions DROP COLUMN concrete_scope;
ALTER TABLE submissions ADD COLUMN concrete_scope TEXT;
