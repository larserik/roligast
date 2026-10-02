// Marks on a sign-in request: things that are true of it, recorded whether or
// not anything is done about them. Nothing here decides anything on its own -
// what, if anything, a signal leads to is settled in requestPin, and for now the
// answer is nothing.

// What each signal would also be true of, for a real person:
//
//   quoted_ua    nothing I can construct. No browser wraps the header in
//                quotes. Someone editing their own user agent by hand could
//                leave them in, which is the one case worth remembering.
//   ua_mismatch  a user agent spoofing extension, or a proxy that rewrites the
//                header and leaves the client hints alone.
//   no_js        JavaScript off, an extension blocking beacons, or simply
//                leaving within a second and a half of the page loading.
//   tor          anyone who values not being followed around. Never a trigger.
export const SIGNALS = ["quoted_ua", "ua_mismatch", "no_js", "tor"];

const quoted = (ua) => {
  const value = (ua || "").trim();
  return value.length > 2 && value.startsWith('"') && value.endsWith('"');
};

// Which operating system the user agent string claims.
function platformFromUa(ua) {
  if (/Android/i.test(ua)) return "Android";
  if (/iPhone|iPad|iPod/i.test(ua)) return "iOS";
  if (/Macintosh|Mac OS X/i.test(ua)) return "macOS";
  if (/Windows NT/i.test(ua)) return "Windows";
  if (/CrOS/i.test(ua)) return "Chrome OS";
  if (/Linux|X11/i.test(ua)) return "Linux";
  return null;
}

// Chromium browsers send sec-ch-ua alongside the user agent, and the two have
// to be forged together to agree. Firefox and Safari send no hints at all,
// which is not a disagreement - there is simply nothing to compare.
export function uaMismatch(ua, brands, platformHint) {
  if (!ua || !brands) return false;

  const hinted = (platformHint || "").replace(/"/g, "").trim();
  const claimed = platformFromUa(ua);
  if (hinted && claimed && hinted !== claimed) return true;

  // "Chrome/142" in the user agent against the version in the brand list.
  const uaVersion = (ua.match(/Chrome\/(\d+)/) || [])[1];
  const hintVersion = (brands.match(/"(?:Google )?Chrom(?:e|ium)";\s*v="(\d+)"/) || [])[1];
  if (uaVersion && hintVersion && uaVersion !== hintVersion) return true;

  // Chrome always names itself among its brands. A build that calls itself
  // Chrome in the user agent but lists only Chromium is not Chrome.
  if (/Chrome\/\d/.test(ua) && /Chromium/.test(brands) && !/Google Chrome/.test(brands)) {
    return true;
  }
  return false;
}

// A browser that ran the page sends its first batch a second and a half in. Two
// pages and nothing at all means the script was fetched and never executed -
// unless they left very quickly, which is why one page view is not enough.
export const noJs = (pageViews, events) => pageViews >= 2 && events === 0;

// Returns the signals that apply, as a sorted list.
export function detectSignals({
  userAgent,
  brands,
  platformHint,
  isTor,
  pageViews = 0,
  events = 0,
}) {
  const found = [];
  if (quoted(userAgent)) found.push("quoted_ua");
  if (uaMismatch(userAgent, brands, platformHint)) found.push("ua_mismatch");
  if (noJs(pageViews, events)) found.push("no_js");
  if (isTor) found.push("tor");
  return found;
}

// --- what is done about them -----------------------------------------------
// off     the signals are recorded and never looked at again
// report  a request that would be refused a code is noted as such, and the code
//         is sent anyway. This is the default, so deploying changes nothing.
// on      no code is sent, and nothing else about the response changes
const MODES = new Set(["off", "report", "on"]);
const rawMode = String(process.env.SUPPRESS_SIGNINS || "report").toLowerCase();
export const MODE = MODES.has(rawMode) ? rawMode : "report";

// tor is deliberately absent and should stay absent: it says something about
// how someone reaches the site, not about whether they are a person.
export const TRIGGERS = String(process.env.SUPPRESS_ON || "quoted_ua")
  .split(",")
  .map((name) => name.trim())
  .filter((name) => SIGNALS.includes(name) && name !== "tor");

// An address with an account behind it is never refused, whatever the signals
// say. Being silently unable to sign in is the worst thing this could do, and
// it must not happen to someone who has signed in before.
export function decide(signals, { hasAccount }) {
  if (MODE === "off" || hasAccount) return { withhold: false, note: false, reason: null };
  const matched = signals.filter((name) => TRIGGERS.includes(name));
  if (matched.length === 0) return { withhold: false, note: false, reason: null };
  return {
    withhold: MODE === "on",
    note: MODE === "report",
    reason: matched.join(","),
  };
}
