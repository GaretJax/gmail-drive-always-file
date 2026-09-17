/*
 * settings.js
 *
 * Shared configuration for the "Gmail Drive: Always Attach" extension.
 *
 * This file is loaded before picker.js in every matching frame. Content
 * scripts from the same extension share one isolated JavaScript world per
 * frame, so the `GDAF` object defined here is visible to picker.js.
 *
 * Settings live in chrome.storage.sync so they follow the signed-in Chrome
 * profile and stay in sync with the options page.
 */

(function () {
  "use strict";

  // Default configuration. Kept small and self-documenting so the options
  // page and the picker logic agree on the shape.
  const DEFAULTS = {
    // Master switch: swap the two footer buttons (styling + position) so
    // "Insert as attachment" takes the primary/default slot.
    swapButtons: true,

    // When a file is confirmed in the picker (double-click or Enter), insert
    // it as an attachment instead of the built-in default (a Drive link).
    // In the fallback case (attachment unavailable, e.g. a native Google Doc)
    // the gesture is suppressed so a link is never inserted by accident.
    overrideDefaultAction: true,

    // Regular expressions (as strings) used to recognise the two buttons by
    // their visible text / aria-label. Localisable: override these on the
    // options page for non-English Gmail. They are matched case-insensitively.
    //
    // The "link" button is anything mentioning a link; the "attachment"
    // button anything mentioning an attachment. `attachmentPattern` is checked
    // first so a hypothetical "attach as link" style label is not misfiled.
    attachmentPattern: "attach",
    linkPattern: "link"
  };

  const GDAF = {
    DEFAULTS,

    // Current, resolved settings (defaults until load() completes).
    current: Object.assign({}, DEFAULTS),

    // Compiled RegExp helpers, refreshed whenever settings change.
    attachmentRe: new RegExp(DEFAULTS.attachmentPattern, "i"),
    linkRe: new RegExp(DEFAULTS.linkPattern, "i"),

    _listeners: [],

    _compile() {
      // Guard against a user typing an invalid regex on the options page:
      // fall back to the defaults rather than throwing.
      try {
        this.attachmentRe = new RegExp(this.current.attachmentPattern || DEFAULTS.attachmentPattern, "i");
      } catch (e) {
        this.attachmentRe = new RegExp(DEFAULTS.attachmentPattern, "i");
      }
      try {
        this.linkRe = new RegExp(this.current.linkPattern || DEFAULTS.linkPattern, "i");
      } catch (e) {
        this.linkRe = new RegExp(DEFAULTS.linkPattern, "i");
      }
    },

    // Register a callback fired whenever settings change at runtime.
    onChange(fn) {
      this._listeners.push(fn);
    },

    _notify() {
      this._compile();
      for (const fn of this._listeners) {
        try {
          fn(this.current);
        } catch (e) {
          /* never let one listener break the others */
        }
      }
    },

    // Load settings from storage. Resolves to the current settings object.
    load() {
      return new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          this._compile();
          resolve(this.current);
        };

        try {
          if (!chrome || !chrome.storage || !chrome.storage.sync) {
            return finish();
          }
          chrome.storage.sync.get(DEFAULTS, (stored) => {
            if (!chrome.runtime.lastError && stored) {
              this.current = Object.assign({}, DEFAULTS, stored);
            }
            finish();
          });
        } catch (e) {
          finish();
        }
      });
    }
  };

  // React to changes made from the options page (or another tab) live.
  try {
    if (chrome && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "sync") return;
        let touched = false;
        for (const key of Object.keys(GDAF.DEFAULTS)) {
          if (Object.prototype.hasOwnProperty.call(changes, key)) {
            GDAF.current[key] = changes[key].newValue;
            touched = true;
          }
        }
        if (touched) GDAF._notify();
      });
    }
  } catch (e) {
    /* storage not available in this context; defaults apply */
  }

  // Expose to the sibling content script(s) in this frame.
  self.GDAF = GDAF;
})();
