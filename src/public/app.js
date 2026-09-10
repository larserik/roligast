// Rating without a page reload. The form still works exactly as it did when
// this never runs: it is an ordinary POST that redirects back.
(function () {
  "use strict";

  if (!window.fetch) return;

  function paint(widget, data) {
    var average = widget.querySelector("[data-average]");
    var count = widget.querySelector("[data-count]");
    var status = widget.querySelector("[data-status]");

    if (average && data.average) {
      average.textContent = data.average;
      var score = average.closest("[data-score]");
      if (score) score.classList.remove("is-empty");
    }
    if (count && data.summary) count.textContent = data.summary;
    if (status && data.thanks) {
      status.textContent = data.thanks;
      status.classList.add("is-thanks");
    }
  }

  function choose(widget, value) {
    widget.querySelectorAll(".rate-btn").forEach(function (button) {
      var chosen = Number(button.value) === value;
      button.classList.toggle("is-chosen", chosen);
      button.setAttribute("aria-pressed", chosen ? "true" : "false");
    });
  }

  document.addEventListener("submit", function (event) {
    var form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.matches(".rating-form")) return;

    // Which of the ten buttons was pressed. Without it there is nothing to
    // send, so the browser's own submission is left alone.
    var button = event.submitter;
    if (!button || !button.value) return;

    var widget = form.closest("[data-rating]");
    if (!widget) return;

    event.preventDefault();

    var value = Number(button.value);
    var previous = widget.querySelector(".rate-btn.is-chosen");
    choose(widget, value);

    var body = new URLSearchParams();
    body.set("value", String(value));

    fetch(form.action, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      credentials: "same-origin",
    })
      .then(function (response) {
        if (!response.ok) throw new Error("status " + response.status);
        return response.json();
      })
      .then(function (data) {
        paint(widget, data);
      })
      .catch(function () {
        // A rating that was never stored must not be left looking saved.
        choose(widget, previous ? Number(previous.value) : 0);
        var status = widget.querySelector("[data-status]");
        if (status && status.dataset.error) {
          status.classList.remove("is-thanks");
          status.textContent = status.dataset.error;
        }
      });
  });
})();

// Gives feedback while a form is being submitted: the submit button turns into
// a spinner and is disabled, so slow requests (sending a code by mail) cannot
// be triggered twice by an impatient click.
(function () {
  "use strict";

  function startLoading(button) {
    if (button.dataset.originalText === undefined) {
      button.dataset.originalText = button.textContent;
    }
    var label = button.dataset.loadingText || button.dataset.originalText;

    var spinner = document.createElement("span");
    spinner.className = "spinner";
    spinner.setAttribute("aria-hidden", "true");

    button.textContent = "";
    button.appendChild(spinner);
    button.appendChild(document.createTextNode(" " + label));
    button.classList.add("is-loading");
    button.setAttribute("aria-busy", "true");

    // Disabling on the next tick: a button disabled while the submit event is
    // still being handled is not sent along with the form in some browsers.
    setTimeout(function () {
      button.disabled = true;
    }, 0);
  }

  function stopLoading(button) {
    if (button.dataset.originalText !== undefined) {
      button.textContent = button.dataset.originalText;
    }
    button.classList.remove("is-loading");
    button.removeAttribute("aria-busy");
    button.disabled = false;
  }

  document.addEventListener("submit", function (event) {
    var form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    // Someone else already stopped the submission - a rating, for instance.
    if (event.defaultPrevented || form.matches(".rating-form")) return;

    if (form.dataset.confirm && !window.confirm(form.dataset.confirm)) {
      event.preventDefault();
      return;
    }
    if (form.dataset.submitting === "true") {
      event.preventDefault();
      return;
    }

    var button = form.querySelector('button[type="submit"], button:not([type])');
    if (!button || button.disabled) return;

    form.dataset.submitting = "true";
    startLoading(button);
  });

  // Coming back via the back button can restore the page from the cache with
  // the button still spinning; reset it so the form stays usable.
  window.addEventListener("pageshow", function (event) {
    if (!event.persisted) return;
    document.querySelectorAll("form[data-submitting]").forEach(function (form) {
      delete form.dataset.submitting;
    });
    document.querySelectorAll("button.is-loading").forEach(stopLoading);
  });
})();

// Sends the one-time code as soon as it is complete, so a pasted code or one
// picked from the iOS keyboard needs no further tap. Codes arriving with a
// space or a dash in them are cleaned up first. Without JavaScript the button
// is still there to press.
(function () {
  "use strict";

  var field = document.querySelector(".pin-input");
  if (!field) return;

  var form = field.form;
  if (!form) return;

  var LENGTH = 6;
  var submitted = false;

  function digitsFrom(text) {
    return String(text || "").replace(/\D/g, "").slice(0, LENGTH);
  }

  function submitWhenComplete() {
    var digits = digitsFrom(field.value);
    if (digits !== field.value) field.value = digits;
    if (digits.length !== LENGTH || submitted) return;

    submitted = true;
    // requestSubmit runs the same path as pressing the button, so the field is
    // validated and the button shows that something is happening.
    if (typeof form.requestSubmit === "function") {
      form.requestSubmit();
    } else {
      form.submit();
    }
  }

  // A pasted code can carry a space or a dash, which maxlength would otherwise
  // cut off before the last digit, so it is read from the paste itself.
  field.addEventListener("paste", function (event) {
    var text = event.clipboardData && event.clipboardData.getData("text");
    if (!text) return;
    event.preventDefault();
    field.value = digitsFrom(text);
    submitWhenComplete();
  });

  field.addEventListener("input", submitWhenComplete);
})();

// "Copy link" on a post.
(function () {
  "use strict";

  document.addEventListener("click", function (event) {
    if (!(event.target instanceof Element)) return;
    var button = event.target.closest("[data-copy]");
    if (!button) return;

    var url = window.location.origin + "/p/" + button.dataset.copy;
    var done = function () {
      var original = button.dataset.originalText || button.textContent;
      button.dataset.originalText = original;
      button.textContent = button.dataset.copied || original;
      setTimeout(function () {
        button.textContent = original;
      }, 2000);
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, function () {});
      return;
    }
    // Older browsers: a hidden field is the only way in.
    var field = document.createElement("input");
    field.value = url;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.appendChild(field);
    field.select();
    try {
      document.execCommand("copy");
      done();
    } catch (err) {
      /* nothing else to try */
    }
    document.body.removeChild(field);
  });
})();
