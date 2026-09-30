import express from "express";
import cookieParser from "cookie-parser";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import db from "./db.js";
import { generatePostId, generateVisitorId } from "./ids.js";
import { parseUrl, kindOf } from "./embed.js";
import { startNetworkLookups } from "./network.js";
import { average, ratePost, ratingFor, claimRatings } from "./ratings.js";
import {
  LANGS,
  DEFAULT_LANG,
  normalizeLang,
  langFromHeader,
  translator,
} from "./i18n.js";
import {
  isValidEmail,
  requestPin,
  verifyPin,
  logout,
  sessionMiddleware,
  requireUser,
  pruneExpired,
  recordLoginEvent,
} from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
// The reverse proxy in front of this terminates TLS, so the real protocol and
// client address arrive in X-Forwarded-* headers. One hop, not "true": trusting
// every hop makes req.ip the leftmost X-Forwarded-For entry, which is whatever
// the client put there. Counting one hop takes the address nginx itself saw.
app.set("trust proxy", 1);
app.disable("x-powered-by");

// Static files first, so serving them costs no session lookup or database work.
app.use(
  "/static",
  express.static(path.join(__dirname, "public"), { maxAge: "1y" })
);

app.use(express.urlencoded({ extended: false, limit: "64kb" }));
app.use(cookieParser());

// Static files are cached hard, so their URLs carry a hash of the contents.
// Without it a deploy leaves visitors on the previous stylesheet until their
// cache expires, and only a hard reload brings the new one in.
const publicDir = path.join(__dirname, "public");
const assetUrls = new Map(
  fs.readdirSync(publicDir).map((file) => {
    const hash = crypto
      .createHash("sha1")
      .update(fs.readFileSync(path.join(publicDir, file)))
      .digest("hex")
      .slice(0, 10);
    return [file, `/static/${file}?v=${hash}`];
  })
);
app.locals.asset = (file) => assetUrls.get(file) || `/static/${file}`;

// --- Cookies ---------------------------------------------------------------
// The Secure flag follows the actual protocol (via X-Forwarded-Proto and trust
// proxy); browsers discard a Secure cookie delivered over plain HTTP.
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const REMEMBERED_EMAIL = "remembered_email";
const VISITOR_COOKIE = "visitor";
const LANG_COOKIE = "lang";

const cookieOpts = (req, maxAge, httpOnly = true) => {
  const options = { httpOnly, sameSite: "lax", secure: req.secure, path: "/" };
  if (maxAge) options.maxAge = maxAge;
  return options;
};

// --- Language --------------------------------------------------------------
app.use((req, res, next) => {
  const cookie = req.cookies?.[LANG_COOKIE];
  const lang = LANGS.includes(cookie)
    ? cookie
    : langFromHeader(req.headers["accept-language"]);
  res.locals.lang = lang;
  res.locals.otherLang = lang === "sv" ? "en" : "sv";
  res.locals.t = translator(lang);
  req.lang = lang;
  next();
});

app.use(sessionMiddleware);

// --- Who is rating ---------------------------------------------------------
// Signed in, a rating belongs to the account and follows the person to their
// next device. Signed out it belongs to this browser, which is enough to keep
// one visitor from rating the same post ten times.
app.use((req, res, next) => {
  let visitor = req.cookies?.[VISITOR_COOKIE];
  // Noted before a new one is handed out. Anyone who filled in a form on this
  // site was given this cookie when they loaded the page it was on, so a
  // request arriving without one never loaded a page.
  req.hadVisitorCookie = /^[0-9a-f]{32}$/.test(visitor || "");
  if (!req.hadVisitorCookie) {
    visitor = generateVisitorId();
    res.cookie(VISITOR_COOKIE, visitor, cookieOpts(req, YEAR_MS));
  }
  req.visitorKey = `v:${visitor}`;
  req.raterKey = req.user ? `u:${req.user.id}` : req.visitorKey;
  res.locals.raterKey = req.raterKey;
  next();
});

// --- View helpers ----------------------------------------------------------
const dateFormats = {
  sv: new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Stockholm",
    day: "numeric",
    month: "long",
    year: "numeric",
  }),
  en: new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Stockholm",
    day: "numeric",
    month: "long",
    year: "numeric",
  }),
};

// SQLite stores timestamps as UTC text; recent ones read better as "3 tim
// sedan" than as a date.
const parseStamp = (value) => new Date(`${String(value).replace(" ", "T")}Z`);

function formatWhen(value, lang) {
  const date = parseStamp(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const t = translator(lang);
  const minutes = Math.floor((Date.now() - date.getTime()) / 60000);
  if (minutes < 2) return t("time_just_now");
  if (minutes < 60) return t("time_minutes", { n: minutes });
  if (minutes < 60 * 24) return t("time_hours", { n: Math.floor(minutes / 60) });
  if (minutes < 60 * 24 * 7)
    return t("time_days", { n: Math.floor(minutes / (60 * 24)) });
  return (dateFormats[lang] || dateFormats[DEFAULT_LANG]).format(date);
}

const formatAverage = (sum, count) => {
  const value = average(sum, count);
  return value === null ? null : value.toFixed(1).replace(".", ",");
};

app.use((req, res, next) => {
  res.locals.formatWhen = (value) => formatWhen(value, res.locals.lang);
  res.locals.formatAverage = formatAverage;
  // A signed-in poster shows as their display name, or as the public id they
  // are given until they pick one. Someone who did not sign in shows as the
  // name they typed, or as "Anonym".
  res.locals.authorName = (post) =>
    post.display_name ||
    post.author_public_id ||
    post.author_name ||
    res.locals.t("anonymous");
  res.locals.ratingSummary = (count) =>
    count === 1
      ? res.locals.t("rating_count_one")
      : res.locals.t("rating_count_other", { count });
  res.locals.media = (post) => (post.url ? parseUrl(post.url) : null);
  res.locals.query = req.query;
  res.locals.path = req.path;
  // The language switch and the sign-out button send the visitor back to the
  // page they were on.
  res.locals.currentUrl = req.originalUrl;
  next();
});

// What the sign-in log records about a request beyond the address typed in.
const loginContext = (req) => ({
  ip: req.ip,
  userAgent: req.get("user-agent"),
  referer: req.get("referer"),
  acceptLanguage: req.get("accept-language"),
  hasVisitorCookie: req.hadVisitorCookie,
});

// Only allows redirects back into this site. A browser reads "//evil.se" and
// "/\evil.se" as absolute URLs, so a plain leading slash is not enough.
const safeNext = (next) => (/^\/($|[^/\\])/.test(next || "") ? next : "/");

// --- Language switch -------------------------------------------------------
app.get("/lang/:code", (req, res) => {
  const code = normalizeLang(req.params.code);
  res.cookie(LANG_COOKIE, code, cookieOpts(req, YEAR_MS, false));
  res.redirect(safeNext(req.query.next));
});

// --- Listing ---------------------------------------------------------------
const KINDS = ["joke", "clip", "image", "link"];
const SORTS = {
  // Highest rated first, with a nudge for the posts that plenty of people
  // agreed on.
  top: "p.score DESC, p.rating_count DESC, p.created_at DESC",
  // The same score, faded as the post ages: roughly halved after three days.
  hot: `(p.score * (1.0 / (1.0 + (julianday('now') - julianday(p.created_at)) / 3.0))) DESC,
        p.created_at DESC`,
  new: "p.created_at DESC",
};
const PAGE_SIZE = 24;

const listPosts = (sort, kind, raterKey, limit, offset) =>
  db
    .prepare(
      `SELECT p.*, u.display_name, u.public_id AS author_public_id, r.value AS my_rating
       FROM posts p
       LEFT JOIN users u ON u.id = p.user_id
       LEFT JOIN ratings r ON r.post_id = p.id AND r.rater_key = ?
       ${kind ? "WHERE p.kind = ?" : ""}
       ORDER BY ${SORTS[sort]}
       LIMIT ? OFFSET ?`
    )
    .all(...(kind ? [raterKey, kind, limit, offset] : [raterKey, limit, offset]));

app.get("/", (req, res) => {
  const sort = SORTS[req.query.sort] ? req.query.sort : "top";
  const kind = KINDS.includes(req.query.kind) ? req.query.kind : null;
  const page = Math.max(1, Math.min(500, Number(req.query.page) || 1));
  const offset = (page - 1) * PAGE_SIZE;

  // One row more than a page is asked for, purely to know whether there is a
  // next page without counting the whole table.
  const rows = listPosts(sort, kind, req.raterKey, PAGE_SIZE + 1, offset);
  const posts = rows.slice(0, PAGE_SIZE);
  const hasMore = rows.length > PAGE_SIZE;

  res.render("index", {
    title: null,
    posts,
    sort,
    kind,
    page,
    hasMore,
    total: db.prepare("SELECT COUNT(*) AS n FROM posts").get().n,
  });
});

// --- A single post ---------------------------------------------------------
const findPost = (publicId, raterKey) =>
  db
    .prepare(
      `SELECT p.*, u.display_name, u.public_id AS author_public_id, r.value AS my_rating
       FROM posts p
       LEFT JOIN users u ON u.id = p.user_id
       LEFT JOIN ratings r ON r.post_id = p.id AND r.rater_key = ?
       WHERE p.public_id = ?`
    )
    .get(raterKey, publicId);

app.get("/p/:publicId", (req, res, next) => {
  const post = findPost(req.params.publicId, req.raterKey);
  if (!post) return next();

  const more = db
    .prepare(
      `SELECT p.*, u.display_name, u.public_id AS author_public_id, r.value AS my_rating
       FROM posts p
       LEFT JOIN users u ON u.id = p.user_id
       LEFT JOIN ratings r ON r.post_id = p.id AND r.rater_key = ?
       WHERE p.id != ?
       ORDER BY ${SORTS.hot}
       LIMIT 6`
    )
    .all(req.raterKey, post.id);

  res.render("post", {
    title: post.title,
    post,
    more,
    mine: post.author_key === req.raterKey || post.author_key === req.visitorKey,
  });
});

// --- Rating ----------------------------------------------------------------
const wantsJson = (req) =>
  (req.get("accept") || "").includes("application/json");

app.post("/p/:publicId/rate", (req, res, next) => {
  const value = Number(req.body.value);
  const post = db
    .prepare("SELECT id, public_id FROM posts WHERE public_id = ?")
    .get(req.params.publicId);
  if (!post) return next();

  if (!Number.isInteger(value) || value < 1 || value > 10) {
    if (wantsJson(req)) {
      return res.status(400).json({ error: res.locals.t("rate_error") });
    }
    return res.redirect(`/p/${post.public_id}`);
  }

  const totals = ratePost(post.id, req.raterKey, value);

  if (wantsJson(req)) {
    return res.json({
      myRating: value,
      count: totals.rating_count,
      average: formatAverage(totals.rating_sum, totals.rating_count),
      summary: res.locals.ratingSummary(totals.rating_count),
      thanks: res.locals.t("rate_saved"),
    });
  }
  // Without JavaScript the rating is an ordinary form post; coming back to the
  // page the visitor was reading beats dropping them somewhere else.
  res.redirect(safeNext(req.body.next));
});

// --- Adding something ------------------------------------------------------
const POSTS_PER_HOUR = 10;
const TITLE_MAX = 120;
const BODY_MAX = 5000;
const NAME_MAX = 40;

function parseName(raw) {
  const name = (raw || "").trim().replace(/\s+/g, " ");
  if (name === "") return { name: null };
  if (name.length > NAME_MAX) return { error: "err_name_long" };
  if (name.includes("@")) return { error: "err_name_at" };
  return { name };
}

app.get("/add", (req, res) => {
  res.render("add", {
    title: res.locals.t("add_title"),
    error: null,
    values: { title: "", body: "", url: "", name: "" },
  });
});

app.post("/add", (req, res) => {
  const t = res.locals.t;
  const values = {
    title: String(req.body.title || "").trim(),
    body: String(req.body.body || "").trim(),
    url: String(req.body.url || "").trim(),
    name: String(req.body.name || "").trim(),
  };
  const fail = (error) =>
    res.status(400).render("add", { title: t("add_title"), error: t(error), values });

  if (!values.title) return fail("err_title_required");
  if (values.title.length > TITLE_MAX) return fail("err_title_long");
  if (values.body.length > BODY_MAX) return fail("err_body_long");
  if (!values.body && !values.url) return fail("err_content_required");

  let media = null;
  if (values.url) {
    media = parseUrl(values.url);
    if (!media) return fail("err_url_invalid");
  }

  // Signed in, the name on a post comes from the account, so the form does not
  // ask for one.
  let name = null;
  if (!req.user) {
    const parsed = parseName(values.name);
    if (parsed.error) return fail(parsed.error);
    name = parsed.name;
  }

  const recent = db
    .prepare(
      `SELECT COUNT(*) AS n FROM posts
       WHERE author_key = ? AND created_at > datetime('now', '-1 hour')`
    )
    .get(req.raterKey).n;
  if (recent >= POSTS_PER_HOUR) return fail("err_rate_limit");

  const insert = db.prepare(
    `INSERT INTO posts (public_id, user_id, author_key, author_name, title, body, url, kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let publicId = null;
  for (let attempt = 0; attempt < 10 && publicId === null; attempt++) {
    const candidate = generatePostId();
    try {
      insert.run(
        candidate,
        req.user ? req.user.id : null,
        req.raterKey,
        req.user ? null : name,
        values.title,
        values.body || null,
        media ? media.url : null,
        kindOf(media)
      );
      publicId = candidate;
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
  if (!publicId) return fail("err_generic");

  res.redirect(`/p/${publicId}`);
});

app.post("/p/:publicId/delete", (req, res, next) => {
  const post = db
    .prepare("SELECT id, author_key FROM posts WHERE public_id = ?")
    .get(req.params.publicId);
  if (!post) return next();
  // Signed in, someone can also remove what they posted from this browser
  // before signing in - the two keys are the same person.
  if (post.author_key !== req.raterKey && post.author_key !== req.visitorKey) {
    return res.status(403).render("404", {
      title: res.locals.t("not_found_title"),
    });
  }
  db.prepare("DELETE FROM posts WHERE id = ?").run(post.id);
  res.redirect(safeNext(req.body.next) || "/");
});

// --- Signing in ------------------------------------------------------------
app.get("/login", (req, res) => {
  if (req.user) return res.redirect(safeNext(req.query.next));
  res.render("login", {
    title: res.locals.t("login_title"),
    error: null,
    email: req.cookies?.[REMEMBERED_EMAIL] || "",
    remember: true,
    next: safeNext(req.query.next),
  });
});

app.post("/login", async (req, res) => {
  const t = res.locals.t;
  const email = String(req.body.email || "").trim().toLowerCase();
  const remember = req.body.remember === "1";
  const next = safeNext(req.body.next);

  const showLogin = (error, status = 400) =>
    res.status(status).render("login", {
      title: t("login_title"),
      error: t(error),
      email,
      remember,
      next,
    });

  if (!isValidEmail(email)) {
    recordLoginEvent(email, "invalid_email", loginContext(req));
    return showLogin("err_email_invalid");
  }

  // The remembered address is kept apart from the session so that signing out,
  // or a session running out, still leaves the login form filled in.
  if (remember) {
    res.cookie(REMEMBERED_EMAIL, email, cookieOpts(req, YEAR_MS));
  } else {
    res.clearCookie(REMEMBERED_EMAIL, cookieOpts(req));
  }

  let result;
  try {
    result = await requestPin(email, req.lang, loginContext(req));
  } catch (err) {
    console.error("[login] could not send the code:", err);
    return showLogin("err_generic", 500);
  }
  if (!result.ok) return showLogin(result.error);

  res.render("verify", {
    title: t("verify_title"),
    error: null,
    email,
    remember,
    next,
  });
});

app.post("/verify", (req, res) => {
  const t = res.locals.t;
  const email = String(req.body.email || "").trim().toLowerCase();
  const pin = String(req.body.pin || "").replace(/\D/g, "");
  const remember = req.body.remember === "1";
  const next = safeNext(req.body.next);

  if (!isValidEmail(email)) {
    recordLoginEvent(email, "invalid_email", loginContext(req));
    return res.status(400).render("login", {
      title: t("login_title"),
      error: t("err_email_invalid"),
      email,
      remember,
      next,
    });
  }

  const result = verifyPin(email, pin, loginContext(req));
  if (!result.ok) {
    return res.status(400).render("verify", {
      title: t("verify_title"),
      error: t(result.error),
      email,
      remember,
      next,
    });
  }

  res.cookie("session", result.token, cookieOpts(req, result.maxAge));
  if (remember) {
    res.cookie(REMEMBERED_EMAIL, email, cookieOpts(req, YEAR_MS));
  }
  // Whatever this browser rated before signing in now belongs to the account.
  claimRatings(req.visitorKey, `u:${result.user.id}`);
  res.redirect(next);
});

app.post("/logout", (req, res) => {
  logout(req.cookies?.session);
  res.clearCookie("session", cookieOpts(req));
  res.redirect(safeNext(req.body.next));
});

// --- Mine ------------------------------------------------------------------
app.get("/me", requireUser, (req, res) => {
  const userKey = `u:${req.user.id}`;
  const posts = db
    .prepare(
      `SELECT p.*, u.display_name, u.public_id AS author_public_id, r.value AS my_rating
       FROM posts p
       LEFT JOIN users u ON u.id = p.user_id
       LEFT JOIN ratings r ON r.post_id = p.id AND r.rater_key = ?
       WHERE p.author_key IN (?, ?)
       ORDER BY p.created_at DESC`
    )
    .all(userKey, userKey, req.visitorKey);

  const rated = db
    .prepare(
      `SELECT p.*, u.display_name, u.public_id AS author_public_id, r.value AS my_rating
       FROM ratings r
       JOIN posts p ON p.id = r.post_id
       LEFT JOIN users u ON u.id = p.user_id
       WHERE r.rater_key = ?
       ORDER BY r.created_at DESC
       LIMIT 100`
    )
    .all(userKey);

  res.render("me", {
    title: res.locals.t("me_title"),
    posts,
    rated,
    error: null,
    saved: req.query.saved === "1",
  });
});

app.post("/me", requireUser, (req, res) => {
  const { name, error } = parseName(req.body.display_name);
  if (error) {
    const userKey = `u:${req.user.id}`;
    return res.status(400).render("me", {
      title: res.locals.t("me_title"),
      posts: db
        .prepare(
          `SELECT p.*, u.display_name, u.public_id AS author_public_id, r.value AS my_rating
           FROM posts p
           LEFT JOIN users u ON u.id = p.user_id
           LEFT JOIN ratings r ON r.post_id = p.id AND r.rater_key = ?
           WHERE p.author_key IN (?, ?)
           ORDER BY p.created_at DESC`
        )
        .all(userKey, userKey, req.visitorKey),
      rated: [],
      error: res.locals.t(error),
      saved: false,
    });
  }
  db.prepare("UPDATE users SET display_name = ? WHERE id = ?").run(
    name,
    req.user.id
  );
  res.redirect("/me?saved=1");
});

// --- Odds and ends ---------------------------------------------------------
app.get("/healthz", (req, res) => res.type("text").send("ok"));

app.use((req, res) => {
  res.status(404).render("404", { title: res.locals.t("not_found_title") });
});

app.use((err, req, res, next) => {
  console.error("[error]", err);
  if (res.headersSent) return next(err);
  res.status(500).render("404", {
    title: res.locals.t ? res.locals.t("err_generic") : "Error",
  });
});

// The Tor exit list loads in the background and refreshes through the day.
startNetworkLookups();

// Expired sessions and unused codes are cleared at start and once a day after.
pruneExpired();
setInterval(pruneExpired, 24 * 60 * 60 * 1000).unref();

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`roligast listening on port ${port}`);
});
