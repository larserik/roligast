// What a visitor did, from the server's side and from the browser's.
//
// Nothing here is allowed to affect what a visitor sees: every write is wrapped
// so a failure is complained about and then forgotten. The point is a record to
// read afterwards, not a feature anyone depends on.

import db from "./db.js";
import { isTorExit, reverseDns } from "./network.js";

// Headers worth keeping from the request that first brought someone here. The
// whole set is small, but cookies are left out on purpose - the session token
// is in there, and a log is not the place for it.
const SKIP_HEADERS = new Set(["cookie", "authorization"]);
const HEADERS_MAX = 2000;
const TARGET_MAX = 160;
const DETAIL_MAX = 900;
const PATH_MAX = 300;

// Caps. A browser that never stops is a browser whose later events say nothing
// the first few hundred did not.
export const EVENTS_PER_REQUEST = 200;
export const PAGE_VIEWS_PER_VISITOR = 2000;
export const EVENTS_PER_VISITOR = 5000;

const trim = (value, max) => (value ? String(value).slice(0, max) : null);

const insertVisitor = db.prepare(
  `INSERT INTO visitors
     (id, landing_path, landing_referer, ip, network, user_agent, accept_language, headers, page_views)
   VALUES (@id, @path, @referer, @ip, @network, @userAgent, @acceptLanguage, @headers, 0)
   ON CONFLICT(id) DO NOTHING`
);
const touchVisitor = db.prepare(
  `UPDATE visitors SET last_seen = strftime('%Y-%m-%d %H:%M:%f', 'now'),
                       page_views = page_views + 1
   WHERE id = ?`
);
const setVisitorRdns = db.prepare(
  "UPDATE visitors SET rdns = ? WHERE id = ? AND rdns IS NULL"
);
const setVisitorUser = db.prepare(
  "UPDATE visitors SET user_id = ? WHERE id = ? AND user_id IS NULL"
);
const insertPageView = db.prepare(
  `INSERT INTO page_views (visitor_id, method, path, referer, status, duration_ms)
   VALUES (?, ?, ?, ?, ?, ?)`
);
const insertEvent = db.prepare(
  `INSERT INTO visitor_events (visitor_id, path, type, target, detail, at_ms)
   VALUES (?, ?, ?, ?, ?, ?)`
);
const countPageViews = db.prepare(
  "SELECT page_views AS n FROM visitors WHERE id = ?"
);
const countEvents = db.prepare("SELECT events AS n FROM visitors WHERE id = ?");
const bumpEvents = db.prepare(
  "UPDATE visitors SET events = events + ?, last_seen = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id = ?"
);

// Only a referer from somewhere else says anything about how they arrived; one
// from this site is just the previous page, which page_views already has.
function externalReferer(referer, host) {
  if (!referer) return null;
  try {
    const url = new URL(referer);
    if (host && url.host === host) return null;
    return referer;
  } catch {
    return referer;
  }
}

function headerBlob(req) {
  const kept = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (SKIP_HEADERS.has(name)) continue;
    kept[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return trim(JSON.stringify(kept), HEADERS_MAX);
}

// Called once per request, before the response goes out.
export function noteVisitor(req) {
  try {
    insertVisitor.run({
      id: req.visitorId,
      path: trim(req.originalUrl, PATH_MAX),
      referer: trim(externalReferer(req.get("referer"), req.get("host")), PATH_MAX),
      ip: req.ip || null,
      network: isTorExit(req.ip) ? "tor" : null,
      userAgent: trim(req.get("user-agent"), 300),
      acceptLanguage: trim(req.get("accept-language"), 100),
      headers: headerBlob(req),
    });
    touchVisitor.run(req.visitorId);

    if (req.ip) {
      reverseDns(req.ip)
        .then((hostname) => {
          if (hostname) setVisitorRdns.run(hostname, req.visitorId);
        })
        .catch(() => {});
    }
  } catch (err) {
    console.error("[tracking] visitor", err.message);
  }
}

export function notePageView(req, res, startedAt) {
  try {
    const seen = countPageViews.get(req.visitorId)?.n ?? 0;
    if (seen > PAGE_VIEWS_PER_VISITOR) return;
    insertPageView.run(
      req.visitorId,
      req.method,
      trim(req.originalUrl, PATH_MAX),
      trim(req.get("referer"), PATH_MAX),
      res.statusCode,
      Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6)
    );
  } catch (err) {
    console.error("[tracking] page view", err.message);
  }
}

// Ties a browser to the account it signed into, so a journey can be read from
// either end.
export function linkVisitorToUser(visitorId, userId) {
  try {
    setVisitorUser.run(userId, visitorId);
  } catch (err) {
    console.error("[tracking] link", err.message);
  }
}

// The browser's own account of what happened, arriving in batches.
export const recordEvents = db.transaction((visitorId, path, events) => {
  const already = countEvents.get(visitorId)?.n ?? 0;
  if (already > EVENTS_PER_VISITOR) return 0;

  let written = 0;
  for (const event of events.slice(0, EVENTS_PER_REQUEST)) {
    if (!event || typeof event.e !== "string") continue;
    insertEvent.run(
      visitorId,
      trim(path, PATH_MAX),
      event.e.slice(0, 24),
      trim(event.el, TARGET_MAX),
      event.d === undefined || event.d === null
        ? null
        : trim(typeof event.d === "string" ? event.d : JSON.stringify(event.d), DETAIL_MAX),
      Number.isFinite(event.t) ? Math.round(event.t) : null
    );
    written++;
  }
  if (written) bumpEvents.run(written, visitorId);
  return written;
});
