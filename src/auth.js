import crypto from "node:crypto";
import db from "./db.js";
import { sendPin } from "./mailer.js";
import { generatePublicId } from "./ids.js";

const PIN_TTL_MS = 10 * 60 * 1000;
const PIN_RESEND_MS = 60 * 1000;
const PIN_MAX_ATTEMPTS = 5;
const SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000;

const hashPin = (email, pin) =>
  crypto.createHash("sha256").update(`${email}:${pin}`).digest("hex");

export const SESSION_MAX_AGE_MS = SESSION_TTL_MS;

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

// Errors come back as keys rather than sentences: the page they end up on is
// rendered in whichever language the visitor is reading the site in.
export async function requestPin(email, lang) {
  const now = Date.now();
  const existing = db
    .prepare("SELECT last_sent_at FROM login_pins WHERE email = ?")
    .get(email);
  if (existing && now - existing.last_sent_at < PIN_RESEND_MS) {
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
  await sendPin(email, pin, lang);
  return { ok: true };
}

export function verifyPin(email, pin) {
  const row = db.prepare("SELECT * FROM login_pins WHERE email = ?").get(email);
  if (!row || row.expires_at < Date.now()) {
    return { ok: false, error: "pin_expired" };
  }
  if (row.attempts >= PIN_MAX_ATTEMPTS) {
    db.prepare("DELETE FROM login_pins WHERE email = ?").run(email);
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
    return { ok: false, error: "pin_wrong" };
  }
  db.prepare("DELETE FROM login_pins WHERE email = ?").run(email);

  let user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user) user = createUser(email);
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
}
