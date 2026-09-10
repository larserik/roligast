import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const dbPath = process.env.DATABASE_PATH || "./data/roligast.db";
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    public_id TEXT NOT NULL UNIQUE,
    display_name TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS login_pins (
    email TEXT PRIMARY KEY,
    pin_hash TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL,
    last_sent_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );

  -- Anyone may post, so user_id is empty for a post left without signing in.
  -- author_key identifies the poster either way ("u:<id>" or "v:<visitor>"),
  -- which is what lets someone edit or delete what they added themselves.
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_id TEXT NOT NULL UNIQUE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    author_key TEXT NOT NULL,
    author_name TEXT,
    title TEXT NOT NULL,
    body TEXT,
    url TEXT,
    kind TEXT NOT NULL,
    rating_count INTEGER NOT NULL DEFAULT 0,
    rating_sum INTEGER NOT NULL DEFAULT 0,
    -- Rating average pulled towards the middle while there are few votes, so a
    -- single 10 does not outrank a post fifty people liked. See rankScore().
    score REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
  );

  -- One rating per post and rater. rater_key is "u:<id>" once signed in, so a
  -- rating follows the account rather than the browser it was cast from.
  CREATE TABLE IF NOT EXISTS ratings (
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    rater_key TEXT NOT NULL,
    value INTEGER NOT NULL CHECK (value BETWEEN 1 AND 10),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (post_id, rater_key)
  );

  CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_posts_score ON posts(score DESC, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_posts_kind ON posts(kind, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_key, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_ratings_rater ON ratings(rater_key, created_at DESC);
`);

export default db;
