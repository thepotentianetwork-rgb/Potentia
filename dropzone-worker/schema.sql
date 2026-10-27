CREATE TABLE IF NOT EXISTS feedback (id TEXT PRIMARY KEY, source TEXT NOT NULL, site TEXT, note TEXT NOT NULL, name TEXT, email TEXT, business_name TEXT, screenshot TEXT, screenshots TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, reviewed_at TEXT, ip TEXT);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at);
CREATE INDEX IF NOT EXISTS idx_feedback_ip ON feedback(ip, created_at);
