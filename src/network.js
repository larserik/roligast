// What can be told about where a request came from, without asking the request.
//
// Two things only, both cheap: whether the address is a published Tor exit, and
// what it calls itself in reverse DNS. Neither is allowed to hold up a sign-in -
// the exit list is a set already in memory, and the reverse lookup happens after
// the visitor has their answer.

import dns from "node:dns";

const TOR_EXIT_LIST = "https://check.torproject.org/torbulkexitlist";
const TOR_REFRESH_MS = 6 * 60 * 60 * 1000;
const RDNS_TIMEOUT_MS = 2000;
// Reverse lookups are a property of the address, not of the event, so the same
// address is only ever asked about once.
const RDNS_CACHE_MAX = 5000;

let torExits = new Set();
let torFetchedAt = null;

export async function refreshTorExits() {
  try {
    const response = await fetch(TOR_EXIT_LIST, {
      signal: AbortSignal.timeout(15000),
      headers: { "user-agent": "roligast (sign-in log)" },
    });
    if (!response.ok) throw new Error(`status ${response.status}`);
    const listed = (await response.text())
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    if (listed.length === 0) throw new Error("empty list");
    torExits = new Set(listed);
    torFetchedAt = new Date();
    console.log(`[network] ${torExits.size} Tor exit addresses loaded`);
  } catch (err) {
    // An old list beats no list, and no list only means the column stays empty.
    console.error("[network] could not refresh the Tor exit list:", err.message);
  }
}

export const isTorExit = (ip) => Boolean(ip) && torExits.has(ip);

export const torListStatus = () => ({
  addresses: torExits.size,
  fetched_at: torFetchedAt ? torFetchedAt.toISOString() : null,
});

// Starts the list and keeps it current. Never throws, never blocks startup.
export function startNetworkLookups() {
  refreshTorExits();
  setInterval(refreshTorExits, TOR_REFRESH_MS).unref();
}

const rdnsCache = new Map();
const resolver = new dns.promises.Resolver({ timeout: RDNS_TIMEOUT_MS, tries: 1 });

export async function reverseDns(ip) {
  if (!ip) return null;
  if (rdnsCache.has(ip)) return rdnsCache.get(ip);

  let hostname = null;
  try {
    const names = await resolver.reverse(ip);
    hostname = names[0] || null;
  } catch {
    // No PTR record, or the lookup timed out. Both are ordinary.
    hostname = null;
  }
  // A plain cap rather than an expiry: these answers change rarely, and the
  // point is only to stop the map growing without bound.
  if (rdnsCache.size >= RDNS_CACHE_MAX) rdnsCache.clear();
  rdnsCache.set(ip, hostname);
  return hostname;
}
