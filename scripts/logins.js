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
import { refreshTorExits, isTorExit, reverseDns } from "../src/network.js";

const dbPath = process.env.DATABASE_PATH || "./data/roligast.db";
if (!fs.existsSync(dbPath)) {
  console.error(`No database at ${dbPath}. Set DATABASE_PATH if it lives elsewhere.`);
  process.exit(1);
}
const WRITES = new Set(["prune", "enrich"]);
const db = new Database(dbPath, { readonly: !WRITES.has(process.argv[2]) });

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

// Rows written before the referer, cookie and network columns existed have
// has_visitor_cookie NULL, and nothing written since does. That is the marker
// for "never recorded", which must not be read as "absent".
const OLD_ROW = "has_visitor_cookie IS NULL";
// No browser sends a User-Agent wrapped in double quotes. Tooling that pastes a
// quoted string straight into the header does.
const QUOTED_UA = `user_agent LIKE '"%"'`;
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
      `SELECT id, created_at, email, event, ip,
              CASE WHEN ${OLD_ROW} AND network IS NULL THEN '?' ELSE COALESCE(network, '-') END AS network,
              CASE has_visitor_cookie WHEN 1 THEN 'yes' WHEN 0 THEN 'NO' ELSE '?' END AS cookie,
              CASE WHEN ${OLD_ROW} THEN '?'
                   WHEN referer IS NULL THEN 'NO' ELSE 'yes' END AS referer,
              CASE WHEN ${QUOTED_UA} THEN 'quoted' ELSE '' END AS ua,
              detail
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
              MAX(network) AS network,
              MAX(rdns) AS rdns,
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

// A browser that filled in the form carries the cookie it was given on the way
// in and a referer pointing back here. A Tor exit is worth seeing on its own.
const automated = (n) =>
  db
    .prepare(
      `SELECT ip, MAX(network) AS network, MAX(rdns) AS rdns,
              COUNT(*) AS events, COUNT(DISTINCT email) AS addresses,
              SUM(event = 'sent') AS mails_sent,
              SUM(event = 'verified') AS signed_in,
              SUM(has_visitor_cookie = 0) AS no_cookie,
              SUM(has_visitor_cookie IS NOT NULL AND referer IS NULL) AS no_referer,
              SUM(${QUOTED_UA}) AS quoted_ua,
              MAX(accept_language) AS accept_language,
              MAX(user_agent) AS user_agent
       FROM login_events
       WHERE created_at > ${since(n)}
         AND (network = 'tor' OR ${QUOTED_UA}
              OR has_visitor_cookie = 0
              OR (has_visitor_cookie IS NOT NULL AND referer IS NULL))
       GROUP BY ip ORDER BY events DESC`
    )
    .all();

const networks = (n) =>
  db
    .prepare(
      `SELECT CASE WHEN network IS NOT NULL THEN network
                   WHEN ${OLD_ROW} THEN 'not recorded'
                   ELSE 'ordinary' END AS network,
              COUNT(*) AS events, COUNT(DISTINCT ip) AS ips,
              COUNT(DISTINCT email) AS addresses,
              SUM(event = 'sent') AS mails_sent,
              SUM(event = 'verified') AS signed_in
       FROM login_events WHERE created_at > ${since(n)}
       GROUP BY 1 ORDER BY events DESC`
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
    heading(`By network, ${window(n)}`);
    show(networks(n));
    heading(`Where it came from, ${window(n)}`);
    show(byIp(n));
    heading(`Looks automated, ${window(n)}`);
    show(automated(n), "nothing - every request carried a cookie and a referer");
    heading(`Sent a code and never signed in, ${window(n)}`);
    show(unverified(n), "none - every code that went out was used");
    heading("The last 15 events");
    show(recent(15));
  },

  full() {
    const limit = Number(positional[0]) || 30;
    heading(`The last ${limit} events, every column`);
    show(
      db
        .prepare(
          `SELECT id, created_at, email, event, ip,
                  CASE WHEN ${OLD_ROW} AND network IS NULL THEN '?' ELSE COALESCE(network, '-') END AS network,
                  COALESCE(rdns, '-') AS rdns,
                  CASE has_visitor_cookie WHEN 1 THEN 'yes' WHEN 0 THEN 'NO' ELSE '?' END AS cookie,
                  CASE WHEN ${OLD_ROW} THEN '?' WHEN referer IS NULL THEN 'NO'
                       ELSE replace(replace(referer, 'https://', ''), 'http://', '') END AS referer,
                  COALESCE(accept_language, '-') AS lang,
                  COALESCE(detail, '') AS detail,
                  CASE WHEN ${QUOTED_UA} THEN 'quoted ' ELSE '' END ||
                    COALESCE(substr(replace(user_agent, '"', ''), 1, 38), '-') AS user_agent
           FROM login_events ORDER BY id DESC LIMIT ?`
        )
        .all(limit)
    );
    console.log("  user_agent is cut at 38 characters; logins.js show <id> for one event in full.");
  },

  show() {
    const id = Number(positional[0]);
    if (!id) return console.error("Which event? logins.js show 25");
    const row = db.prepare("SELECT * FROM login_events WHERE id = ?").get(id);
    if (!row) return console.error(`No event with id ${id}.`);
    heading(`Event ${id}`);
    for (const [field, value] of Object.entries(row)) {
      console.log(`  ${field.padEnd(19)} ${value === null ? "(null)" : value}`);
    }
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

  bots() {
    const n = days(30);
    heading(`Tor, or no cookie, or no referer - ${window(n)}`);
    show(automated(n), "nothing - every request looked like a browser");
    console.log(
      "  no_cookie counts requests that never loaded a page on this site first."
    );
  },

  networks() {
    const n = days(30);
    heading(`By network, ${window(n)}`);
    show(networks(n));
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
          `SELECT id, created_at, event, ip, network, rdns, detail,
                has_visitor_cookie AS cookie, referer, accept_language, user_agent
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
          `SELECT id, created_at, email, event, network, rdns, detail,
                has_visitor_cookie AS cookie, referer, accept_language, user_agent
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

  // Rows written before the network and rdns columns existed have nothing in
  // them. The address is still there, so both can be worked out after the fact.
  async enrich() {
    const pending = db
      .prepare(
        `SELECT DISTINCT ip FROM login_events
         WHERE ip IS NOT NULL AND (rdns IS NULL OR network IS NULL)`
      )
      .all()
      .map((row) => row.ip);
    if (pending.length === 0) return console.log("Nothing left to fill in.");

    console.log(`Looking up ${pending.length} addresses …`);
    await refreshTorExits();

    const setRdns = db.prepare(
      "UPDATE login_events SET rdns = ? WHERE ip = ? AND rdns IS NULL"
    );
    const setTor = db.prepare(
      "UPDATE login_events SET network = 'tor' WHERE ip = ? AND network IS NULL"
    );

    let named = 0;
    let tor = 0;
    for (const ip of pending) {
      const hostname = await reverseDns(ip);
      if (hostname) named += setRdns.run(hostname, ip).changes;
      // Only ever set 'tor', never 'ordinary': an address absent from today's
      // list may still have been an exit when the request came in, and saying
      // so either way would be inventing history.
      if (isTorExit(ip)) tor += setTor.run(ip).changes;
    }
    console.log(
      `Named ${named} rows from reverse DNS, marked ${tor} as coming over Tor.`
    );
  },

  help() {
    console.log(`
Reads the sign-in log in ${dbPath}

  overview [days]      everything below at a glance (default, 7 days)
  summary [days]       counts per event type
  ips [days]           where the traffic came from
  unverified [days]    addresses sent a code that never signed in (default 30)
  daily [days]         day by day, for spotting a burst (default 30)
  full [n]             every column for the last n events (default 30)
  show <id>            one event, every field, nothing truncated
  bots [days]          Tor exits, quoted user agents, missing cookie or referer
  networks [days]      how much came over Tor rather than an ordinary line
  recent [n]           the last n events (default 50)
  email <address>      everything recorded for one address
  ip <address>         everything recorded from one client address
  users                accounts, with their posts, ratings and live sessions
  pending              codes that are still live
  size                 rows, bytes on disk and how fast it is growing
  enrich               fill in network and reverse DNS on rows that predate them
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
await run();
