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

  // --- form fields ---------------------------------------------------------
  // Timing and shape always; the value only where the page has said it may be
  // recorded, and never from a field that could hold an address or a code.
  var SENSITIVE_TYPE = /^(password|email|tel|hidden)$/;
  var SENSITIVE_NAME = /^(email|pin|password|token)$/;
  var GAPS_MAX = 40;
  var VALUE_MAX = 120;

  function recordsValue(el) {
    if (!el.hasAttribute || !el.hasAttribute("data-track-value")) return false;
    if (SENSITIVE_TYPE.test((el.type || "").toLowerCase())) return false;
    if (SENSITIVE_NAME.test((el.name || "").toLowerCase())) return false;
    return true;
  }

  // One session at a time: the state belongs to this visit to the field, not to
  // the field for the life of the page. Counting across visits is how the same
  // six keystrokes got reported three times.
  var field = null;

  function isField(el) {
    return el && /^(INPUT|TEXTAREA)$/.test(el.tagName);
  }

  function endField() {
    if (!field) return;
    var el = field.el;
    var value = el && el.value ? el.value : "";
    var detail = {
      chars: value.length,
      keys: field.keys,
      edits: field.edits,
      pasted: field.pasted,
      // Characters arrived without a keystroke or a paste: a password manager,
      // the browser's autofill, or a script setting the value outright.
      filled: value.length > 0 && field.keys === 0 && !field.pasted,
      ms: Math.round(performance.now() - field.focusedAt),
      // The pause before each keystroke after the first, in milliseconds. A
      // person's rhythm is uneven and rarely under 40ms; a script's is not.
      gaps: field.gaps,
    };
    if (field.records && value) detail.value = value.slice(0, VALUE_MAX);
    push("field", field.label, detail);
    field = null;
  }

  document.addEventListener(
    "focusin",
    function (event) {
      if (!isField(event.target)) return;
      endField();
      field = {
        el: event.target,
        label: label(event.target),
        records: recordsValue(event.target),
        keys: 0,
        edits: 0,
        gaps: [],
        pasted: false,
        lastKeyAt: null,
        focusedAt: performance.now(),
      };
      push("focus", field.label);
    },
    true
  );

  document.addEventListener(
    "keydown",
    function (event) {
      if (!field || event.target !== field.el) return;
      var now = performance.now();
      if (field.lastKeyAt !== null && field.gaps.length < GAPS_MAX) {
        field.gaps.push(Math.round(now - field.lastKeyAt));
      }
      field.lastKeyAt = now;
      field.keys++;
      // Which key is not recorded. Whether it was removing something is, since
      // that is what hesitating over a field looks like.
      if (event.key === "Backspace" || event.key === "Delete") field.edits++;
    },
    true
  );

  document.addEventListener(
    "paste",
    function (event) {
      if (field && event.target === field.el) field.pasted = true;
    },
    true
  );

  document.addEventListener(
    "focusout",
    function (event) {
      if (field && event.target === field.el) endField();
    },
    true
  );

  document.addEventListener(
    "submit",
    function (event) {
      var form = event.target;
      endField();
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
  window.addEventListener("pagehide", function () {
    endField();
    flush();
  });
  setInterval(flush, FLUSH_EVERY_MS);

  // The first batch goes early, so a visitor who leaves at once still counts.
  setTimeout(flush, 1500);
})();
