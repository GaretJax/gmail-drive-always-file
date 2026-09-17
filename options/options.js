/*
 * options.js — reads/writes settings for the options popup.
 * Reuses the DEFAULTS + load() defined in ../src/settings.js (loaded first).
 */
(function () {
  "use strict";

  const GDAF = self.GDAF;
  const DEFAULTS = GDAF.DEFAULTS;

  const fields = {
    swapButtons: document.getElementById("swapButtons"),
    overrideDoubleClick: document.getElementById("overrideDoubleClick"),
    attachmentPattern: document.getElementById("attachmentPattern"),
    linkPattern: document.getElementById("linkPattern")
  };
  const statusEl = document.getElementById("status");
  const resetBtn = document.getElementById("reset");

  let statusTimer = null;
  function flash(message) {
    statusEl.textContent = message;
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => (statusEl.textContent = ""), 1500);
  }

  function render(settings) {
    fields.swapButtons.checked = !!settings.swapButtons;
    fields.overrideDoubleClick.checked = !!settings.overrideDoubleClick;
    fields.attachmentPattern.value = settings.attachmentPattern;
    fields.linkPattern.value = settings.linkPattern;
  }

  function save(partial) {
    try {
      chrome.storage.sync.set(partial, () => {
        if (chrome.runtime.lastError) {
          flash("Could not save");
        } else {
          flash("Saved");
        }
      });
    } catch (e) {
      flash("Could not save");
    }
  }

  fields.swapButtons.addEventListener("change", (e) =>
    save({ swapButtons: e.target.checked })
  );
  fields.overrideDoubleClick.addEventListener("change", (e) =>
    save({ overrideDoubleClick: e.target.checked })
  );

  // Text patterns save on blur / Enter, and only when non-empty & valid.
  function commitPattern(key, input) {
    const value = input.value.trim();
    if (!value) {
      input.value = DEFAULTS[key];
      save({ [key]: DEFAULTS[key] });
      return;
    }
    try {
      new RegExp(value, "i");
    } catch (err) {
      flash("Invalid pattern");
      return;
    }
    save({ [key]: value });
  }

  ["attachmentPattern", "linkPattern"].forEach((key) => {
    const input = fields[key];
    input.addEventListener("blur", () => commitPattern(key, input));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        input.blur();
      }
    });
  });

  resetBtn.addEventListener("click", () => {
    render(DEFAULTS);
    save(Object.assign({}, DEFAULTS));
    flash("Reset");
  });

  GDAF.load().then(render);
})();
