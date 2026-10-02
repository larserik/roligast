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

  -- Every step of a sign-in, kept whether or not it worked. The tables above
  -- are deliberately forgetful - a pin row is deleted the moment it is spent
  -- and pruned once it expires - which leaves no way to see who has been
  -- asking for codes. This is that record.
  CREATE TABLE IF NOT EXISTS login_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    event TEXT NOT NULL,
    ip TEXT,
    user_agent TEXT,
    detail TEXT,
    -- Where the request says it came from. A browser that filled in the form
    -- arrives with a referer and the visitor cookie it was given on the way in;
    -- something posting straight at /login has neither.
    referer TEXT,
    accept_language TEXT,
    has_visitor_cookie INTEGER,
    -- Filled in from the address itself: its reverse DNS name, and 'tor' when
    -- it is on the published list of exit nodes.
    rdns TEXT,
    network TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
  );

  CREATE INDEX IF NOT EXISTS idx_login_events_created ON login_events(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_login_events_email ON login_events(email, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_login_events_ip ON login_events(ip, created_at DESC);

  -- One row per browser, written the first time it is seen. This is the "how
  -- did they get here" record: the page they landed on, the referer that sent
  -- them, and the whole header set the request arrived with.
  CREATE TABLE IF NOT EXISTS visitors (
    id TEXT PRIMARY KEY,
    first_seen TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
    last_seen TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
    landing_path TEXT,
    landing_referer TEXT,
    ip TEXT,
    rdns TEXT,
    network TEXT,
    user_agent TEXT,
    accept_language TEXT,
    headers TEXT,
    page_views INTEGER NOT NULL DEFAULT 0,
    events INTEGER NOT NULL DEFAULT 0,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
  );

  -- Every page the server rendered for them, in order.
  CREATE TABLE IF NOT EXISTS page_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    visitor_id TEXT NOT NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    referer TEXT,
    status INTEGER,
    duration_ms INTEGER,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
  );

  -- What happened inside those pages, reported by the browser: clicks, scrolls,
  -- which field was being filled and how, what the page loaded. Never the typed
  -- value of anything - only how it arrived.
  CREATE TABLE IF NOT EXISTS visitor_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    visitor_id TEXT NOT NULL,
    path TEXT,
    type TEXT NOT NULL,
    target TEXT,
    detail TEXT,
    at_ms INTEGER,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
  );

  CREATE INDEX IF NOT EXISTS idx_visitors_seen ON visitors(first_seen DESC);
  CREATE INDEX IF NOT EXISTS idx_visitors_ip ON visitors(ip, first_seen DESC);
  CREATE INDEX IF NOT EXISTS idx_page_views_visitor ON page_views(visitor_id, id);
  CREATE INDEX IF NOT EXISTS idx_page_views_created ON page_views(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_visitor_events_visitor ON visitor_events(visitor_id, id);

  CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_posts_score ON posts(score DESC, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_posts_kind ON posts(kind, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_key, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_ratings_rater ON ratings(rater_key, created_at DESC);
`);

// Columns added after a database was first created. ALTER TABLE ADD COLUMN is
// cheap and idempotent this way, so a deploy needs no migration step.
function ensureColumns(table, columns) {
  const existing = new Set(
    db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
  );
  for (const [name, definition] of Object.entries(columns)) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  }
}

// login_events gains the visitor so a sign-in attempt joins to the journey
// that led to it.
ensureColumns("login_events", {
  visitor_id: "TEXT",
  signals: "TEXT",
  referer: "TEXT",
  accept_language: "TEXT",
  has_visitor_cookie: "INTEGER",
  rdns: "TEXT",
  network: "TEXT",
});

db.exec(
  "CREATE INDEX IF NOT EXISTS idx_login_events_network ON login_events(network, created_at DESC)"
);

export default db;
