#!/usr/bin/env node
// Reads the sign-in log. Runs inside the container, where better-sqlite3 and
// DATABASE_PATH already are:
//
//   docker compose exec roligast node scripts/logins.js [command]
//
// or through scripts/logins.sh, which types that part for you. Against a local
// database, DATABASE_PATH=./data/roligast.db node scripts/logins.js.
//
// Nothing here writes to the database except "prune", which asks first.

import Database from "better-sqlite3";
import fs from "node:fs";

const dbPath = process.env.DATABASE_PATH || "./data/roligast.db";
if (!fs.existsSync(dbPath)) {
  console.error(`No database at ${dbPath}. Set DATABASE_PATH if it lives elsewhere.`);
  process.exit(1);
}
const db = new Database(dbPath, { readonly: process.argv[2] !== "prune" });

const [, , rawCommand, ...args] = process.argv;
const command = rawCommand || "overview";
const flags = new Set(args.filter((a) => a.startsWith("--")));
const positional = args.filter((a) => !a.startsWith("--"));

// "0 days" means everything, which is the useful answer often enough to be
// worth spelling.
const days = (fallback) => {
  const n = Number(positional[0]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};
const since = (n) => (n > 0 ? `datetime('now', '-${n} days')` : "'0000-01-01'");
const window = (n) => (n > 0 ? `the last ${n} days` : "all time");

const heading = (text) => console.log(`\n${text}\n${"-".repeat(text.length)}`);
const show = (rows, empty = "nothing recorded") =>
  rows.length ? console.table(rows) : console.log(`  (${empty})`);

const bytes = (n) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

// --- the queries -----------------------------------------------------------

const recent = (limit) =>
  db
    .prepare(
      `SELECT id, created_at, email, event, ip, detail
       FROM login_events ORDER BY id DESC LIMIT ?`
    )
    .all(limit);

const byIp = (n) =>
  db
    .prepare(
      `SELECT ip,
              COUNT(*) AS events,
              COUNT(DISTINCT email) AS addresses,
              SUM(event = 'sent') AS mails_sent,
              SUM(event = 'send_failed') AS failed,
              SUM(event = 'verified') AS signed_in,
              MIN(created_at) AS first_seen,
              MAX(created_at) AS last_seen
       FROM login_events WHERE created_at > ${since(n)}
       GROUP BY ip ORDER BY mails_sent DESC, events DESC`
    )
    .all();

// The shape abuse takes: a code goes out and nobody ever uses it.
const unverified = (n) =>
  db
    .prepare(
      `SELECT email,
              COUNT(*) AS codes_sent,
              COUNT(DISTINCT ip) AS from_ips,
              GROUP_CONCAT(DISTINCT ip) AS ips,
              MAX(created_at) AS last_sent
       FROM login_events
       WHERE event = 'sent' AND created_at > ${since(n)}
         AND email NOT IN (SELECT email FROM login_events WHERE event = 'verified')
       GROUP BY email ORDER BY codes_sent DESC, last_sent DESC`
    )
    .all();

const summary = (n) =>
  db
    .prepare(
      `SELECT event, COUNT(*) AS n, COUNT(DISTINCT email) AS addresses,
              COUNT(DISTINCT ip) AS ips, MAX(created_at) AS last_seen
       FROM login_events WHERE created_at > ${since(n)}
       GROUP BY event ORDER BY n DESC`
    )
    .all();

const perDay = (n) =>
  db
    .prepare(
      `SELECT date(created_at) AS day,
              COUNT(*) AS events,
              SUM(event = 'sent') AS mails_sent,
              SUM(event = 'verified') AS signed_in,
              COUNT(DISTINCT ip) AS ips
       FROM login_events WHERE created_at > ${since(n)}
       GROUP BY day ORDER BY day DESC`
    )
    .all();

function size() {
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS rows,
              MIN(created_at) AS oldest,
              MAX(created_at) AS newest,
              COUNT(DISTINCT email) AS addresses,
              COUNT(DISTINCT ip) AS ips
       FROM login_events`
    )
    .get();

  // dbstat gives the real pages on disk, table and indexes separately.
  const stored = db
    .prepare(
      `SELECT SUM(pgsize) AS bytes FROM dbstat
       WHERE name = 'login_events' OR name LIKE 'idx_login_events%'`
    )
    .get().bytes || 0;

  const week = db
    .prepare(
      `SELECT COUNT(*) AS n FROM login_events WHERE created_at > datetime('now', '-7 days')`
    )
    .get().n;

  // SQLite hands out whole 4 kB pages, so dividing bytes by rows is nonsense
  // until there are enough rows to fill several. 403 is what a row costs once
  // it does, measured over 100,000 of them with a full-length user agent:
  // the row itself plus its three indexes.
  const MEASURED_BYTES_PER_ROW = 403;
  const perRow = totals.rows >= 500 ? stored / totals.rows : MEASURED_BYTES_PER_ROW;

  heading("How much the log is holding");
  console.table([
    {
      rows: totals.rows,
      addresses: totals.addresses,
      ips: totals.ips,
      on_disk: bytes(stored),
      per_row:
        totals.rows >= 500 ? bytes(Math.round(perRow)) : `~${MEASURED_BYTES_PER_ROW} B`,
      oldest: totals.oldest || "-",
      newest: totals.newest || "-",
    },
  ]);
  // In WAL mode recent writes sit in the -wal file until a checkpoint, so the
  // main file on its own understates things.
  const fileSize = [dbPath, `${dbPath}-wal`].reduce(
    (total, file) => total + (fs.existsSync(file) ? fs.statSync(file).size : 0),
    0
  );
  console.log(`  database file: ${bytes(fileSize)}  (${dbPath})`);
  if (week) {
    const perYear = Math.round((week / 7) * 365);
    console.log(
      `  last 7 days: ${week} rows. At that rate: ${perYear.toLocaleString(
        "en-GB"
      )} a year, about ${bytes(Math.round(perRow * perYear))} of database.`
    );
  }
  console.log(
    `  For scale: a million events is roughly ${bytes(
      MEASURED_BYTES_PER_ROW * 1e6
    )}.`
  );
  console.log(
    "  Nothing is deleted on its own. To cut it back by hand, for example:\n" +
      "    node scripts/logins.js prune 365 --yes"
  );
}

function prune(n) {
  if (!(n > 0)) {
    console.error("Say how many days to keep, e.g. prune 365 --yes");
    process.exit(1);
  }
  const doomed = db
    .prepare(
      `SELECT COUNT(*) AS n FROM login_events WHERE created_at < datetime('now', '-${n} days')`
    )
    .get().n;
  if (!flags.has("--yes")) {
    console.log(
      `${doomed} events are older than ${n} days. Nothing has been deleted.\n` +
        `Add --yes to go ahead: node scripts/logins.js prune ${n} --yes`
    );
    return;
  }
  db.prepare(
    `DELETE FROM login_events WHERE created_at < datetime('now', '-${n} days')`
  ).run();
  db.exec("VACUUM");
  console.log(`Deleted ${doomed} events older than ${n} days.`);
}

// --- commands --------------------------------------------------------------

const commands = {
  overview() {
    const n = days(7);
    size();
    heading(`What happened in ${window(n)}`);
    show(summary(n));
    heading(`Where it came from, ${window(n)}`);
    show(byIp(n));
    heading(`Sent a code and never signed in, ${window(n)}`);
    show(unverified(n), "none - every code that went out was used");
    heading("The last 15 events");
    show(recent(15));
  },

  recent() {
    const limit = Number(positional[0]) || 50;
    heading(`The last ${limit} events`);
    show(recent(limit));
  },

  ips() {
    const n = days(7);
    heading(`Where sign-in traffic came from, ${window(n)}`);
    show(byIp(n));
    console.log(
      "  One address, many addresses, no sign-ins is the shape to watch for."
    );
  },

  unverified() {
    const n = days(30);
    heading(`Sent a code and never signed in, ${window(n)}`);
    show(unverified(n), "none - every code that went out was used");
  },

  summary() {
    const n = days(7);
    heading(`Events in ${window(n)}`);
    show(summary(n));
  },

  daily() {
    const n = days(30);
    heading(`Day by day, ${window(n)}`);
    show(perDay(n));
  },

  email() {
    const address = (positional[0] || "").toLowerCase();
    if (!address) return console.error("Which address? logins.js email you@example.com");
    heading(`Everything recorded for ${address}`);
    show(
      db
        .prepare(
          `SELECT id, created_at, event, ip, detail, user_agent
           FROM login_events WHERE email = ? ORDER BY id`
        )
        .all(address)
    );
  },

  ip() {
    const address = positional[0];
    if (!address) return console.error("Which address? logins.js ip 45.9.148.99");
    heading(`Everything recorded from ${address}`);
    show(
      db
        .prepare(
          `SELECT id, created_at, email, event, detail, user_agent
           FROM login_events WHERE ip = ? ORDER BY id`
        )
        .all(address)
    );
  },

  users() {
    heading("Accounts");
    show(
      db
        .prepare(
          `SELECT u.id, u.email, u.public_id, u.display_name, u.created_at,
                  (SELECT COUNT(*) FROM posts p WHERE p.user_id = u.id) AS posts,
                  (SELECT COUNT(*) FROM ratings r WHERE r.rater_key = 'u:' || u.id) AS ratings,
                  (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > unixepoch() * 1000) AS sessions
           FROM users u ORDER BY u.id`
        )
        .all(),
      "nobody has signed in yet"
    );
  },

  pending() {
    heading("Codes still live");
    show(
      db
        .prepare(
          `SELECT email, attempts,
                  datetime(last_sent_at / 1000, 'unixepoch') AS sent_utc,
                  datetime(expires_at / 1000, 'unixepoch') AS expires_utc
           FROM login_pins ORDER BY last_sent_at DESC`
        )
        .all(),
      "no outstanding codes"
    );
  },

  size,
  prune: () => prune(Number(positional[0])),

  help() {
    console.log(`
Reads the sign-in log in ${dbPath}

  overview [days]      everything below at a glance (default, 7 days)
  summary [days]       counts per event type
  ips [days]           where the traffic came from
  unverified [days]    addresses sent a code that never signed in (default 30)
  daily [days]         day by day, for spotting a burst (default 30)
  recent [n]           the last n events (default 50)
  email <address>      everything recorded for one address
  ip <address>         everything recorded from one client address
  users                accounts, with their posts, ratings and live sessions
  pending              codes that are still live
  size                 rows, bytes on disk and how fast it is growing
  prune <days> --yes   delete events older than that. Nothing else ever deletes

Pass 0 for days to mean all time. Events: invalid_email, throttled, requested,
sent, send_failed, wrong_code, expired, too_many, verified.
`);
  },
};

const run = commands[command];
if (!run) {
  console.error(`Unknown command "${command}".`);
  commands.help();
  process.exit(1);
}
run();
