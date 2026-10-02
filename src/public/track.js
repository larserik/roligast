// Tells the server what happened on the page: which links were followed, what
// was clicked, how far it was scrolled, which field was being filled and how,
// and what the browser loaded.
//
// What is never sent: the value of anything anyone types. A field reports how
// many characters it ended up with and whether they were typed, pasted or
// filled in by the browser - never what they were. The email box is the whole
// reason that rule exists.
//
// Nothing here is required for the site to work. If it throws, it throws on its
// own and the page carries on.
(function () {
  "use strict";

  if (!window.navigator || !navigator.sendBeacon || !window.performance) return;

  var ENDPOINT = "/_e";
  var MAX_QUEUED = 200;
  var FLUSH_EVERY_MS = 20000;
  var PATH = location.pathname + location.search;

  var queue = [];
  var sending = false;

  function push(type, target, detail) {
    if (queue.length >= MAX_QUEUED) return;
    queue.push({
      t: Math.round(performance.now()),
      e: type,
      el: target || null,
      d: detail === undefined ? null : detail,
    });
  }

  function flush() {
    if (sending || queue.length === 0) return;
    var batch = queue.splice(0, queue.length);
    try {
      sending = true;
      var body = JSON.stringify({ p: PATH, events: batch });
      navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "application/json" }));
    } catch (err) {
      /* put them back and try on the next flush */
      queue = batch.concat(queue).slice(0, MAX_QUEUED);
    } finally {
      sending = false;
    }
  }

  // A short, readable name for an element: enough to find it again in the
  // page, never its contents.
  function label(el) {
    if (!el || !el.tagName) return null;
    var name = el.tagName.toLowerCase();
    if (el.id) name += "#" + el.id;
    else if (typeof el.className === "string" && el.className.trim()) {
      name += "." + el.className.trim().split(/\s+/).slice(0, 2).join(".");
    }
    if (el.name) name += "[name=" + el.name + "]";
    if (el.tagName === "BUTTON" && el.value) name += "[value=" + el.value + "]";
    if (el.tagName === "A" && el.getAttribute("href")) {
      name += "[href=" + el.getAttribute("href").slice(0, 70) + "]";
    }
    return name.slice(0, 160);
  }

  // --- how the page itself loaded -----------------------------------------
  // Read once the page has finished, or domContentLoadedEventEnd is still 0.
  function noteNavigation() {
    try {
      var nav = performance.getEntriesByType("navigation")[0];
      if (!nav) return;
      push("nav", PATH, {
        type: nav.type,
        ttfb: Math.round(nav.responseStart),
        loaded: Math.round(nav.domContentLoadedEventEnd),
        done: Math.round(nav.loadEventEnd || performance.now()),
        redirects: nav.redirectCount,
      });
    } catch (err) {
      /* timing is a nicety */
    }
  }
  if (document.readyState === "complete") noteNavigation();
  else window.addEventListener("load", noteNavigation);

  try {
    push("screen", null, {
      w: window.innerWidth,
      h: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
      tz: (Intl.DateTimeFormat().resolvedOptions() || {}).timeZone || null,
    });
  } catch (err) {
    /* timing is a nicety */
  }

  // --- what the browser fetched for this page ------------------------------
  function noteResource(entry) {
    // The beacon reporting the page is not part of the page.
    if (String(entry.name).indexOf(ENDPOINT) !== -1) return;
    push("resource", null, {
      url: String(entry.name).slice(0, 160),
      kind: entry.initiatorType,
      ms: Math.round(entry.duration),
      bytes: entry.transferSize || 0,
    });
  }
  try {
    performance.getEntriesByType("resource").forEach(noteResource);
    if (window.PerformanceObserver) {
      new PerformanceObserver(function (list) {
        list.getEntries().forEach(noteResource);
      }).observe({ type: "resource", buffered: false });
    }
  } catch (err) {
    /* older browsers simply report less */
  }

  // --- clicks ---------------------------------------------------------------
  document.addEventListener(
    "click",
    function (event) {
      var el = event.target instanceof Element ? event.target : null;
      var clickable = el && el.closest ? el.closest("a,button,input,label,[data-copy]") : el;
      push("click", label(clickable || el), {
        x: Math.round(event.clientX),
        y: Math.round(event.clientY),
        // false when a script dispatched the event rather than a person
        // causing it. Real input from an automated browser is still trusted,
        // so this catches the careless rather than the determined.
        trusted: event.isTrusted === true,
      });
    },
    true
  );

  // --- scrolling ------------------------------------------------------------
  var depthSeen = 0;
  var scrollTimer = null;
  window.addEventListener(
    "scroll",
    function () {
      if (scrollTimer) return;
      scrollTimer = setTimeout(function () {
        scrollTimer = null;
        var height = Math.max(
          document.body.scrollHeight - window.innerHeight,
          1
        );
        var depth = Math.min(100, Math.round(((window.scrollY || 0) / height) * 100));
        var milestone = Math.floor(depth / 25) * 25;
        if (milestone > depthSeen) {
          depthSeen = milestone;
          push("scroll", null, { depth: milestone });
        }
      }, 250);
    },
    { passive: true }
  );

  // --- form fields: how a value arrived, never what it was ------------------
  var fields = {};
  function fieldState(el) {
    var key = label(el) || "field";
    if (!fields[key]) {
      fields[key] = { keys: 0, pasted: false, focusedAt: null, autofilled: false };
    }
    return fields[key];
  }

  document.addEventListener(
    "focusin",
    function (event) {
      var el = event.target;
      if (!el || !/^(INPUT|TEXTAREA)$/.test(el.tagName)) return;
      fieldState(el).focusedAt = Math.round(performance.now());
      push("focus", label(el));
    },
    true
  );

  document.addEventListener(
    "keydown",
    function (event) {
      var el = event.target;
      if (!el || !/^(INPUT|TEXTAREA)$/.test(el.tagName)) return;
      fieldState(el).keys++;
    },
    true
  );

  document.addEventListener(
    "paste",
    function (event) {
      var el = event.target;
      if (!el || !/^(INPUT|TEXTAREA)$/.test(el.tagName)) return;
      fieldState(el).pasted = true;
    },
    true
  );

  document.addEventListener(
    "focusout",
    function (event) {
      var el = event.target;
      if (!el || !/^(INPUT|TEXTAREA)$/.test(el.tagName)) return;
      var state = fieldState(el);
      var length = el.value ? el.value.length : 0;
      push("field", label(el), {
        chars: length,
        keys: state.keys,
        pasted: state.pasted,
        // Characters appeared without keystrokes or a paste: a password
        // manager, the browser's autofill, or a script setting the value.
        filled: length > 0 && state.keys === 0 && !state.pasted,
        ms: state.focusedAt === null ? null : Math.round(performance.now()) - state.focusedAt,
      });
    },
    true
  );

  document.addEventListener(
    "submit",
    function (event) {
      var form = event.target;
      push("submit", label(form), {
        action: form && form.getAttribute ? String(form.getAttribute("action") || "").slice(0, 80) : null,
        sinceLoad: Math.round(performance.now()),
        trusted: event.isTrusted === true,
      });
      // A submit navigates away, so this batch has to leave now.
      flush();
    },
    true
  );

  // --- leaving --------------------------------------------------------------
  document.addEventListener("visibilitychange", function () {
    push("visibility", null, { state: document.visibilityState });
    if (document.visibilityState === "hidden") flush();
  });
  window.addEventListener("pagehide", flush);
  setInterval(flush, FLUSH_EVERY_MS);

  // The first batch goes early, so a visitor who leaves at once still counts.
  setTimeout(flush, 1500);
})();
