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

  // Coalesces bursts of mutations into a single scan.
  let scanScheduled = false;

  // The Drive picker styles its two footer buttons identically except for a
  // per-component class prefix: the link (primary) button's classes are all
  // prefixed one way, the attachment (secondary) button's another, and the
  // disabled state merely adds one extra token. So we make the attachment
  // button primary by swapping that prefix, which preserves each button's own
  // state (enabled/disabled) while exchanging only the visual role. These hold
  // the two prefixes, learned once from the buttons' natural (pre-swap) state.
  let primaryPrefix = null; // link button's prefix (filled/primary style)
  let secondaryPrefix = null; // attachment button's prefix (secondary style)

  /* ----------------------------- helpers ------------------------------ */

  // Text used to recognise a button. The Drive picker's labels don't line up
  // between aria-label and visible text (e.g. the link button reads
  // aria-label="Insert 1 item" but shows "Add as link"), so we match against
  // both combined.
  function labelOf(el) {
    if (!el) return "";
    const aria = (el.getAttribute && el.getAttribute("aria-label")) || "";
    const text = el.textContent || "";
    return (aria + " " + text).trim();
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

  // Collect the visible attachment / link button candidates in `root`.
  // A disabled button still counts as a candidate: for native Google files
  // Gmail disables the attachment option, and we want to keep (and style) it.
  function collectCandidates(root) {
    const buttons = clickables(root).filter(isVisible);
    const attach = [];
    const link = [];
    for (const btn of buttons) {
      const text = labelOf(btn);
      if (!text) continue;
      // Attachment is tested first: a label containing both words is treated
      // as the attachment button, not the link button.
      if (GDAF.attachmentRe.test(text)) attach.push(btn);
      else if (GDAF.linkRe.test(text)) link.push(btn);
    }
    return { attach, link };
  }

  // From candidate lists, pick the closest attach/link pair (smallest combined
  // depth to their common ancestor within MAX_DEPTH), so a stray text match
  // elsewhere in the picker doesn't defeat the real footer.
  function closestPair(attachCandidates, linkCandidates) {
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
        if (da > MAX_DEPTH || dl > MAX_DEPTH) continue;
        const score = da + dl;
        if (!best || score < best.score) best = { attachBtn, linkBtn, score };
      }
    }
    return best ? { attachBtn: best.attachBtn, linkBtn: best.linkBtn } : null;
  }

  // The picker footer pair (both buttons must exist to swap them).
  function findPair(root) {
    const { attach, link } = collectCandidates(root);
    if (!attach.length || !link.length) return null;
    return closestPair(attach, link);
  }

  // The picker footer for the default-action override. Tolerates a missing
  // attachment button (attachBtn may be null); linkBtn identifies the footer.
  function findFooter(root) {
    const { attach, link } = collectCandidates(root);
    if (!link.length) return null;
    if (attach.length) {
      const pair = closestPair(attach, link);
      if (pair) return pair;
    }
    return { attachBtn: attach[0] || null, linkBtn: link[0] };
  }

  // The per-component style prefix of an element (the part of its first class
  // token before the first "-"). All of a picker button's classes share it.
  function stylePrefix(el) {
    const cls = (el.getAttribute("class") || "").trim();
    if (!cls) return null;
    const first = cls.split(/\s+/)[0];
    const dash = first.indexOf("-");
    return dash > 0 ? first.slice(0, dash) : first;
  }

  // Rewrite every class token on `el` whose prefix is `from` to use `to`,
  // preserving state-variant tokens (e.g. the disabled marker). Returns true
  // if anything changed.
  function reprefix(el, from, to) {
    if (!from || !to || from === to) return false;
    const cls = el.getAttribute("class") || "";
    if (!cls) return false;
    const out = cls
      .split(/\s+/)
      .map((tok) => {
        if (tok === from) return to;
        if (tok.indexOf(from + "-") === 0) return to + tok.slice(from.length);
        return tok;
      })
      .join(" ");
    if (out !== cls) {
      el.setAttribute("class", out);
      return true;
    }
    return false;
  }

  // Learn the primary (link) and secondary (attachment) style prefixes once,
  // from the buttons' natural state. The prefix identifies the component and is
  // stable across enabled/disabled toggles, so learning from any state is safe.
  function learnPrefixes(attachBtn, linkBtn) {
    if (primaryPrefix && secondaryPrefix) return;
    const lp = stylePrefix(linkBtn);
    const ap = stylePrefix(attachBtn);
    if (lp && ap && lp !== ap) {
      primaryPrefix = lp;
      secondaryPrefix = ap;
    }
  }

  // Make the attachment button primary and the link button secondary, and put
  // the (default) attachment button in the right-hand primary slot. Idempotent:
  // safe to run on every scan, and it re-asserts itself if Gmail re-renders.
  function applySwap(attachBtn, linkBtn) {
    learnPrefixes(attachBtn, linkBtn);

    if (primaryPrefix && secondaryPrefix) {
      // Give attachment the primary look, link the secondary look. Preserves
      // each button's own enabled/disabled variant tokens, so a disabled
      // attachment stays greyed (just greyed-primary) in the fallback.
      reprefix(attachBtn, secondaryPrefix, primaryPrefix);
      reprefix(linkBtn, primaryPrefix, secondaryPrefix);
    }

    // Put the attachment button after the link button (primary on the right),
    // only when they are siblings so we never disturb unexpected layouts.
    const parent = linkBtn.parentNode;
    if (
      parent &&
      attachBtn.parentNode === parent &&
      linkBtn.compareDocumentPosition(attachBtn) &
        Node.DOCUMENT_POSITION_PRECEDING
    ) {
      // attachBtn currently precedes linkBtn -> move it just after linkBtn.
      parent.insertBefore(attachBtn, linkBtn.nextSibling);
    }
  }

  function runSwap(root) {
    if (!GDAF.current.swapButtons) return;
    const pair = findPair(root);
    if (!pair) return;
    try {
      applySwap(pair.attachBtn, pair.linkBtn);
    } catch (e) {
      /* leave the picker untouched on any unexpected DOM shape */
    }
  }

  /* ------------- default-action override (double-click + Enter) -------- */

  // True while we are the ones synthesising a click, so our own click on the
  // attachment button is not re-processed.
  let synthesizing = false;

  // Heuristic: does this node look like a selectable file entry in the picker?
  function isFileItem(node) {
    let el = node;
    for (let depth = 0; el && depth < 8; el = el.parentElement, depth++) {
      if (!el.getAttribute) continue;
      const role = el.getAttribute("role");
      if (role === "option" || role === "row" || role === "gridcell" || role === "listitem") {
        return true;
      }
    }
    return false;
  }

  // Handle a "confirm this file" gesture (double-click or Enter) on a file
  // item. We only take over when the attachment button is currently ENABLED,
  // which is a reliable signal that an attachable file is selected: folders and
  // native Google files leave it disabled, so double-clicking a folder to open
  // it, or any other native behaviour, is never blocked.
  //
  // Note: when a native Google file is confirmed, Gmail still inserts a Drive
  // link (attachment being impossible). Suppressing that specific case safely
  // requires telling a native-file row apart from a folder row; that is a
  // follow-up once the file/folder markup is confirmed.
  function handleDefaultAction(event) {
    if (synthesizing) return;
    if (!GDAF.current.overrideDefaultAction) return;

    const target = event.target;
    if (!target) return;

    // Never interfere with a gesture aimed at a button (the footer buttons
    // themselves): let clicking / Entering a focused button do its own thing.
    if (target.closest && target.closest('button, [role="button"]')) return;

    // Only act on a gesture over an actual file item.
    if (!isFileItem(target)) return;

    // Only engage inside a recognised picker footer with an enabled attachment
    // option. Anything else (folder, native file, nothing selected) is left to
    // Gmail so we never break navigation or insert unexpectedly.
    const footer = findFooter(document);
    if (!footer || !footer.linkBtn) return;
    const attachBtn = footer.attachBtn;
    if (!attachBtn || isDisabled(attachBtn)) return;

    // Insert the just-selected file as an attachment instead of a link.
    event.preventDefault();
    event.stopImmediatePropagation();
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

  function onDblClick(event) {
    handleDefaultAction(event);
  }

  function onKeyDown(event) {
    if (event.key !== "Enter") return;
    // Leave modified Enter (Ctrl/Cmd/Alt/Shift+Enter) to the app.
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    handleDefaultAction(event);
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
    // Capture-phase listeners so we run before Gmail's own handlers and can
    // suppress them (double-click and Enter both "confirm" the selected file).
    document.addEventListener("dblclick", onDblClick, true);
    document.addEventListener("keydown", onKeyDown, true);

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
