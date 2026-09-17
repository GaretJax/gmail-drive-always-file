/*
 * picker.js
 *
 * Runs inside every Gmail / Google Drive frame. When the Google Drive picker
 * that Gmail opens from the compose window renders its footer, this script:
 *
 *   1. Swaps the two footer buttons ("Insert as attachment" and
 *      "Insert as Drive link") so that "attachment" takes the primary,
 *      default-styled slot and "link" becomes the secondary option.
 *   2. Overrides double-clicking a file so it inserts as an attachment
 *      instead of the built-in default (a Drive link).
 *
 * The picker is drawn inside a cross-origin iframe served from
 * docs.google.com / drive.google.com. Because this content script is declared
 * with `all_frames: true`, Chrome injects it into that frame too, which is the
 * only place these buttons exist. In the top mail.google.com frame the script
 * simply finds nothing and stays dormant.
 *
 * Google ships obfuscated, frequently-changing CSS class names, so nothing
 * here depends on them. Buttons are located by their visible text / aria-label
 * (configurable for other languages), and the swap is done by exchanging the
 * two elements' positions and class attributes -- each button keeps its own
 * label and click handler but adopts the other's slot and styling.
 */

(function () {
  "use strict";

  const GDAF = self.GDAF;
  if (!GDAF) return; // settings.js failed to load; do nothing.

  // Marks buttons we have already swapped so we don't ping-pong them on every
  // mutation. If Google re-renders fresh button elements the marker is gone
  // and we swap again, which is what we want.
  const SWAP_ATTR = "data-gdaf-swapped";
  // Marks our own container scan so repeated observer hits are cheap no-ops.
  let scanScheduled = false;

  /* ----------------------------- helpers ------------------------------ */

  function labelOf(el) {
    if (!el) return "";
    const aria = el.getAttribute && el.getAttribute("aria-label");
    return String(aria || el.textContent || "").trim();
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = el.ownerDocument.defaultView.getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  function isDisabled(el) {
    if (!el) return false;
    if (el.disabled) return true;
    const ariaDisabled = el.getAttribute && el.getAttribute("aria-disabled");
    return ariaDisabled === "true";
  }

  // All clickable elements in a document/root.
  function clickables(root) {
    return Array.prototype.slice.call(
      root.querySelectorAll('button, [role="button"]')
    );
  }

  // Depth (in parent hops) from `node` up to `ancestor`, or -1 if unrelated.
  function depthTo(node, ancestor) {
    let d = 0;
    for (let n = node; n; n = n.parentNode, d++) {
      if (n === ancestor) return d;
    }
    return -1;
  }

  // Nearest common ancestor of two nodes, or null.
  function commonAncestor(a, b) {
    const seen = new Set();
    for (let n = a; n; n = n.parentNode) seen.add(n);
    for (let n = b; n; n = n.parentNode) if (seen.has(n)) return n;
    return null;
  }

  // Are we running inside Gmail's Drive picker (a framed picker), rather than
  // a full-page docs.google.com / drive.google.com document? The picker is
  // always embedded in an iframe by the Gmail compose window. This gate keeps
  // us away from unrelated UI that also happens to have "attach"/"link"
  // buttons (e.g. a full Google Docs editor's toolbar).
  function inPickerContext() {
    try {
      return window.top !== window.self;
    } catch (e) {
      // Cross-origin access threw -> we are definitely inside a framed context.
      return true;
    }
  }

  /* --------------------------- button swap ---------------------------- */

  // Find the attachment/link button pair inside `root`, if present and ready.
  // Considers every attach candidate against every link candidate and picks
  // the closest pair (smallest combined depth to their common ancestor), so a
  // stray text match elsewhere in the picker doesn't defeat the real footer.
  function findPair(root) {
    const buttons = clickables(root).filter(isVisible);

    const attachCandidates = [];
    const linkCandidates = [];
    for (const btn of buttons) {
      const text = labelOf(btn);
      if (!text) continue;
      // Attachment is tested first: a label containing both words is treated
      // as the attachment button, not the link button.
      if (GDAF.attachmentRe.test(text)) attachCandidates.push(btn);
      else if (GDAF.linkRe.test(text)) linkCandidates.push(btn);
    }
    if (!attachCandidates.length || !linkCandidates.length) return null;

    const MAX_DEPTH = 6;
    let best = null;
    for (const attachBtn of attachCandidates) {
      for (const linkBtn of linkCandidates) {
        if (attachBtn === linkBtn) continue;
        const ancestor = commonAncestor(attachBtn, linkBtn);
        if (!ancestor) continue;
        const da = depthTo(attachBtn, ancestor);
        const dl = depthTo(linkBtn, ancestor);
        if (da < 0 || dl < 0) continue;
        const score = da + dl;
        // Only a genuinely close pair (a shared footer container) qualifies.
        if (da > MAX_DEPTH || dl > MAX_DEPTH) continue;
        if (!best || score < best.score) {
          best = { attachBtn, linkBtn, score };
        }
      }
    }

    return best ? { attachBtn: best.attachBtn, linkBtn: best.linkBtn } : null;
  }

  // Swap two sibling-ish buttons: exchange DOM position and class attribute so
  // the attachment button ends up where the (primary) link button was, wearing
  // its styling, and vice versa. Each element keeps its own text + listeners.
  function swapButtons(attachBtn, linkBtn) {
    if (attachBtn.getAttribute(SWAP_ATTR) && linkBtn.getAttribute(SWAP_ATTR)) {
      return false; // already done for these exact elements
    }

    const doc = attachBtn.ownerDocument;

    // 1) Swap positions using a placeholder so it works whether or not the
    //    two buttons are direct siblings.
    const placeholder = doc.createComment("gdaf-swap");
    const attachParent = attachBtn.parentNode;
    const linkParent = linkBtn.parentNode;
    if (!attachParent || !linkParent) return false;

    attachParent.insertBefore(placeholder, attachBtn);
    linkParent.insertBefore(attachBtn, linkBtn);
    attachParent.insertBefore(linkBtn, placeholder);
    placeholder.remove();

    // 2) Swap the class attribute (visual styling: primary vs secondary).
    const attachClass = attachBtn.getAttribute("class") || "";
    const linkClass = linkBtn.getAttribute("class") || "";
    attachBtn.setAttribute("class", linkClass);
    linkBtn.setAttribute("class", attachClass);

    // 3) Move the visual "default/primary" hints that Google may set via
    //    attributes rather than class.
    swapAttr(attachBtn, linkBtn, "autofocus");
    // Keep aria-label in step with each button's own text (do NOT swap it):
    // labels stay attached to their button so screen readers stay correct.

    attachBtn.setAttribute(SWAP_ATTR, "1");
    linkBtn.setAttribute(SWAP_ATTR, "1");
    return true;
  }

  function swapAttr(a, b, name) {
    const av = a.getAttribute(name);
    const bv = b.getAttribute(name);
    if (bv !== null) a.setAttribute(name, bv);
    else a.removeAttribute(name);
    if (av !== null) b.setAttribute(name, av);
    else b.removeAttribute(name);
  }

  function runSwap(root) {
    if (!GDAF.current.swapButtons) return;
    const pair = findPair(root);
    if (!pair) return;
    try {
      swapButtons(pair.attachBtn, pair.linkBtn);
    } catch (e) {
      /* leave the picker untouched on any unexpected DOM shape */
    }
  }

  /* ----------------------- double-click override ---------------------- */

  // True while we are the ones synthesising a click, so our own click on the
  // attachment button is not re-processed.
  let synthesizing = false;

  // Heuristic: does this node look like a selectable file entry in the picker?
  function isFileItem(node) {
    let el = node;
    for (let depth = 0; el && depth < 8; el = el.parentElement, depth++) {
      const role = el.getAttribute && el.getAttribute("role");
      if (role === "option" || role === "row" || role === "gridcell") return true;
      // The Drive picker also uses data-id on file tiles.
      if (el.hasAttribute && el.hasAttribute("data-id")) return true;
    }
    return false;
  }

  function currentAttachButton(root) {
    // After a swap the attachment button still carries the attachment text,
    // so we locate it by label regardless of styling.
    const buttons = clickables(root).filter(isVisible);
    for (const btn of buttons) {
      if (GDAF.attachmentRe.test(labelOf(btn))) return btn;
    }
    return null;
  }

  function onDblClick(event) {
    if (synthesizing) return;
    if (!GDAF.current.overrideDoubleClick) return;

    const target = event.target;
    if (!target) return;

    // Ignore double-clicks on the footer buttons themselves.
    if (
      target.closest &&
      target.closest('button, [role="button"]')
    ) {
      return;
    }

    // Only intercept double-clicks on an actual file item.
    if (!isFileItem(target)) return;

    const root = event.currentTarget instanceof Document
      ? event.currentTarget
      : document;

    const attachBtn = currentAttachButton(root);
    if (!attachBtn || isDisabled(attachBtn)) {
      // No attachment option (e.g. native Google Docs can only be linked):
      // let Gmail's default behaviour proceed.
      return;
    }

    // Stop Gmail's built-in "insert as link on double-click" from firing...
    event.preventDefault();
    event.stopImmediatePropagation();

    // ...and insert the just-selected file as an attachment instead.
    synthesizing = true;
    try {
      attachBtn.click();
    } finally {
      // Release on the next tick so any follow-on events from .click() that
      // Google might dispatch are still recognised as ours.
      setTimeout(() => {
        synthesizing = false;
      }, 0);
    }
  }

  /* ----------------------------- wiring ------------------------------- */

  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    // Coalesce bursts of mutations into a single scan on the next frame.
    const cb = function () {
      scanScheduled = false;
      runSwap(document);
    };
    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(cb);
    } else {
      window.setTimeout(cb, 16);
    }
  }

  function start() {
    // Capture-phase double-click listener so we run before Gmail's own
    // handler and can suppress it.
    document.addEventListener("dblclick", onDblClick, true);

    // Watch for the picker footer appearing / re-rendering.
    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "aria-label", "aria-disabled", "disabled"]
    });

    // First pass in case the footer is already there.
    scheduleScan();

    // Re-run the swap if settings change at runtime.
    GDAF.onChange(function () {
      scheduleScan();
    });
  }

  // Only run inside the framed Drive picker; never touch a full-page
  // docs.google.com / drive.google.com document.
  if (!inPickerContext()) return;

  // Load settings, then start. Because we run at document_start,
  // document.documentElement already exists.
  GDAF.load().then(start);
})();
