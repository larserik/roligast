import crypto from "node:crypto";
import db from "./db.js";
import { sendPin } from "./mailer.js";
import { generatePublicId } from "./ids.js";
import { isTorExit, reverseDns } from "./network.js";
import { decide, MODE, TRIGGERS } from "./signals.js";

const PIN_TTL_MS = 10 * 60 * 1000;
const PIN_RESEND_MS = 60 * 1000;
const PIN_MAX_ATTEMPTS = 5;
const SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000;

// A user agent is logged to tell a browser from a script, not to fingerprint
// anyone, so only the front of it is kept.
const USER_AGENT_MAX = 200;
// What a real send costs, from the nginx log: 194-325ms against 1-8ms for a
// request that sends nothing.
const SEND_DELAY_MIN_MS = 170;
const SEND_DELAY_SPREAD_MS = 220;
const REFERER_MAX = 300;
const ACCEPT_LANGUAGE_MAX = 100;
const insertEvent = db.prepare(
  `INSERT INTO login_events
     (email, event, ip, user_agent, detail, referer, accept_language,
      has_visitor_cookie, network, visitor_id, signals)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const setRdns = db.prepare("UPDATE login_events SET rdns = ? WHERE id = ?");

const trim = (value, max) => (value ? String(value).slice(0, max) : null);

// Every step of a sign-in, whether or not it worked. Nothing here is allowed to
// stop someone getting in, so a log that cannot be written is only complained
// about.
export function recordLoginEvent(email, event, context = {}, detail = null) {
  let id;
  try {
    // Whether the address is a Tor exit is a lookup in a set already in memory,
    // so it costs nothing to decide here.
    const result = insertEvent.run(
      email || "",
      event,
      context.ip || null,
      trim(context.userAgent, USER_AGENT_MAX),
      detail,
      trim(context.referer, REFERER_MAX),
      trim(context.acceptLanguage, ACCEPT_LANGUAGE_MAX),
      context.hasVisitorCookie === undefined
        ? null
        : context.hasVisitorCookie
          ? 1
          : 0,
      isTorExit(context.ip) ? "tor" : null,
      context.visitorId || null,
      // An empty string means the signals were worked out and none applied.
      // NULL means they were never worked out, which is true of every row
      // written before they existed. Storing both as NULL would make a clean
      // request indistinguishable from an unexamined one, and the counting
      // that decides whether a signal is safe would be wrong.
      Array.isArray(context.signals) ? context.signals.join(",") : null
    );
    id = result.lastInsertRowid;
  } catch (err) {
    console.error("[login_events] could not record", event, err);
    return;
  }

  // The reverse lookup goes over the network, so it happens after the row is
  // safely written and fills the column in when it comes back. The visitor is
  // never waiting on it.
  if (context.ip) {
    reverseDns(context.ip)
      .then((hostname) => {
        if (hostname) setRdns.run(hostname, id);
      })
      .catch(() => {});
  }
}

const hashPin = (email, pin) =>
  crypto.createHash("sha256").update(`${email}:${pin}`).digest("hex");

export const SESSION_MAX_AGE_MS = SESSION_TTL_MS;

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

// Errors come back as keys rather than sentences: the page they end up on is
// rendered in whichever language the visitor is reading the site in.
export async function requestPin(email, lang, context = {}) {
  const now = Date.now();
  const existing = db
    .prepare("SELECT last_sent_at FROM login_pins WHERE email = ?")
    .get(email);
  if (existing && now - existing.last_sent_at < PIN_RESEND_MS) {
    recordLoginEvent(email, "throttled", context);
    return { ok: false, error: "pin_too_soon" };
  }
  const pin = crypto.randomInt(100000, 1000000).toString();
  db.prepare(
    `INSERT INTO login_pins (email, pin_hash, attempts, expires_at, last_sent_at)
     VALUES (?, ?, 0, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       pin_hash = excluded.pin_hash, attempts = 0,
       expires_at = excluded.expires_at, last_sent_at = excluded.last_sent_at`
  ).run(email, hashPin(email, pin), now + PIN_TTL_MS, now);

  recordLoginEvent(email, "requested", context, lang);

  // An address that has signed in before is never refused a code.
  const hasAccount = Boolean(
    db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)
  );
  const verdict = decide(context.signals || [], { hasAccount });

  if (verdict.note) {
    // Report mode: this is what would have been withheld. The code still goes.
    recordLoginEvent(email, "would_suppress", context, verdict.reason);
  }
  if (verdict.withhold) {
    recordLoginEvent(email, "suppressed", context, verdict.reason);
    // A real send takes a few hundred milliseconds and a skipped one takes
    // none, which is the one way the difference could be measured from
    // outside. This closes it.
    await new Promise((resolve) =>
      setTimeout(resolve, SEND_DELAY_MIN_MS + Math.random() * SEND_DELAY_SPREAD_MS)
    );
    return { ok: true };
  }

  try {
    await sendPin(email, pin, lang);
  } catch (err) {
    // Worth knowing separately: a bounce or a refusal from the mail server is
    // what wears down the domain's standing with the big providers.
    recordLoginEvent(email, "send_failed", context, String(err && err.message));
    throw err;
  }
  recordLoginEvent(email, "sent", context);
  return { ok: true };
}

export function verifyPin(email, pin, context = {}) {
  const row = db.prepare("SELECT * FROM login_pins WHERE email = ?").get(email);
  if (!row || row.expires_at < Date.now()) {
    recordLoginEvent(email, "expired", context);
    return { ok: false, error: "pin_expired" };
  }
  if (row.attempts >= PIN_MAX_ATTEMPTS) {
    db.prepare("DELETE FROM login_pins WHERE email = ?").run(email);
    recordLoginEvent(email, "too_many", context);
    return { ok: false, error: "pin_attempts" };
  }
  if (
    !crypto.timingSafeEqual(
      Buffer.from(row.pin_hash),
      Buffer.from(hashPin(email, pin))
    )
  ) {
    db.prepare("UPDATE login_pins SET attempts = attempts + 1 WHERE email = ?").run(
      email
    );
    recordLoginEvent(email, "wrong_code", context, `attempt ${row.attempts + 1}`);
    return { ok: false, error: "pin_wrong" };
  }
  db.prepare("DELETE FROM login_pins WHERE email = ?").run(email);

  let user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  const isNew = !user;
  if (!user) user = createUser(email);
  recordLoginEvent(
    email,
    "verified",
    context,
    isNew ? "new account" : "returning"
  );
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare(
    "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)"
  ).run(token, user.id, Date.now() + SESSION_TTL_MS);
  return { ok: true, token, user, maxAge: SESSION_TTL_MS };
}

// Creates a user with a unique public id, retrying on collision.
function createUser(email) {
  const insert = db.prepare("INSERT INTO users (email, public_id) VALUES (?, ?)");
  for (let attempt = 0; attempt < 10; attempt++) {
    const publicId = generatePublicId();
    try {
      const { lastInsertRowid } = insert.run(email, publicId);
      return {
        id: lastInsertRowid,
        email,
        public_id: publicId,
        display_name: null,
      };
    } catch (err) {
      if (
        err.code === "SQLITE_CONSTRAINT_UNIQUE" &&
        /public_id/.test(err.message)
      ) {
        continue;
      }
      throw err;
    }
  }
  throw new Error("Could not generate a unique public id for the user");
}

// Said once at startup so the setting is never a surprise.
export function describeSuppression() {
  if (MODE === "off") return "sign-in suppression: off, signals recorded only";
  if (MODE === "report") {
    return `sign-in suppression: reporting only, would act on [${TRIGGERS.join(", ")}] - codes still sent`;
  }
  return `sign-in suppression: ON for [${TRIGGERS.join(", ")}] - no code sent to a matching request without an account`;
}

export function logout(token) {
  if (token) db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

// Middleware: sets req.user when a valid session cookie is present.
export function sessionMiddleware(req, res, next) {
  req.user = null;
  const token = req.cookies?.session;
  if (token) {
    const row = db
      .prepare(
        `SELECT u.id, u.email, u.public_id, u.display_name FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token = ? AND s.expires_at > ?`
      )
      .get(token, Date.now());
    if (row) req.user = row;
  }
  res.locals.user = req.user;
  next();
}

export function requireUser(req, res, next) {
  if (!req.user) {
    return res.redirect("/login?next=" + encodeURIComponent(req.originalUrl));
  }
  next();
}

// Expired rows are dead weight; clearing them keeps the tables from growing
// without bound on a site that is mostly signed-out traffic.
export function pruneExpired() {
  const now = Date.now();
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
  db.prepare("DELETE FROM login_pins WHERE expires_at <= ?").run(now);
  // login_events is deliberately not touched: an abuse pattern is only visible
  // over a long run, and a row is a few dozen bytes. "scripts/logins.js size"
  // reports what it is holding, and its prune command is there to be run by
  // hand if it ever needs it.
}
