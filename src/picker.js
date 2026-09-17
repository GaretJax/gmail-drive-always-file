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

  // Temporary debug logging. Enable by running in the picker frame console:
  //   localStorage.setItem('gdafDebug', '1')   (then reload)
  // Disable with localStorage.removeItem('gdafDebug').
  let DEBUG = false;
  try {
    DEBUG = !!(self.localStorage && self.localStorage.getItem("gdafDebug"));
  } catch (e) {
    /* localStorage may be unavailable */
  }
  function dbg() {
    if (!DEBUG) return;
    try {
      const args = Array.prototype.slice.call(arguments);
      console.log.apply(console, ["[gdaf]"].concat(args));
    } catch (e) {
      /* ignore */
    }
  }

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

  // Rewrite every class token whose prefix is `from` to use `to`, on `el` AND
  // all of its descendants. The picker scopes a button's label, icon, ripple,
  // etc. with the same component prefix as the button, so restyling must cover
  // the whole subtree (otherwise the label loses its styling and disappears).
  // State-variant tokens (e.g. the disabled marker) are preserved.
  function reprefixTree(el, from, to) {
    if (!from || !to || from === to || !el) return;
    const nodes = [el];
    const descendants = el.querySelectorAll("*");
    for (let i = 0; i < descendants.length; i++) nodes.push(descendants[i]);
    for (const node of nodes) {
      const cls = node.getAttribute && node.getAttribute("class");
      if (!cls) continue;
      const out = cls
        .split(/\s+/)
        .map((tok) => {
          if (tok === from) return to;
          if (tok.indexOf(from + "-") === 0) return to + tok.slice(from.length);
          return tok;
        })
        .join(" ");
      if (out !== cls) node.setAttribute("class", out);
    }
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
  // the (default) attachment button in the right-hand slot. Idempotent: safe to
  // run on every scan, and it re-asserts itself if Gmail re-renders.
  function applySwap(attachBtn, linkBtn) {
    learnPrefixes(attachBtn, linkBtn);

    if (primaryPrefix && secondaryPrefix) {
      // Give attachment the primary look, link the secondary look (whole
      // subtree, so labels/icons are restyled too). Preserves each button's
      // own enabled/disabled variant tokens, so a disabled attachment stays
      // greyed (just greyed-primary) in the fallback.
      reprefixTree(attachBtn, secondaryPrefix, primaryPrefix);
      reprefixTree(linkBtn, primaryPrefix, secondaryPrefix);
    }

    // Place the attachment button on the right. The two buttons live in
    // separate wrapper elements, so we find the pair of sibling ancestors that
    // share a common parent and reorder those.
    positionAttachmentRight(attachBtn, linkBtn);
  }

  // Find the two ancestor nodes (one leading to `a`, one to `b`) that are
  // siblings under a shared parent. Returns { parent, aNode, bNode } or null.
  function siblingPair(a, b) {
    const aPath = new Map(); // ancestor -> the child on the path down to `a`
    let child = a;
    for (let n = a.parentNode; n; child = n, n = n.parentNode) aPath.set(n, child);
    let bChild = b;
    for (let n = b.parentNode; n; bChild = n, n = n.parentNode) {
      if (aPath.has(n)) return { parent: n, aNode: aPath.get(n), bNode: bChild };
    }
    return null;
  }

  function positionAttachmentRight(attachBtn, linkBtn) {
    const pair = siblingPair(attachBtn, linkBtn);
    if (!pair) return;
    const { parent, aNode, bNode } = pair;
    if (aNode === bNode) return;

    const display = parent.ownerDocument.defaultView
      .getComputedStyle(parent)
      .display;
    const isFlex = display === "flex" || display === "inline-flex";

    if (isFlex) {
      // Reorder visually without moving DOM nodes (idom-friendly).
      if (aNode.style.order !== "2") aNode.style.order = "2";
      if (bNode.style.order !== "1") bNode.style.order = "1";
    } else if (
      bNode.compareDocumentPosition(aNode) & Node.DOCUMENT_POSITION_PRECEDING
    ) {
      // Not a flex row: physically move attachment's wrapper after link's.
      parent.insertBefore(aNode, bNode.nextSibling);
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

  // The nearest picker row (file/doc/folder) at or above `node`, or null.
  // Located by ARIA role so it works whether the gesture landed on the row or
  // on a thumbnail/label deep inside it.
  function closestRow(node) {
    let el = node;
    for (let depth = 0; el && depth < 12; el = el.parentElement, depth++) {
      if (!el.getAttribute) continue;
      const role = el.getAttribute("role");
      if (role === "option" || role === "row" || role === "gridcell" || role === "listitem") {
        return el;
      }
    }
    return null;
  }

  // Is this row a document/file (as opposed to a folder or other navigation
  // target)? Files AND native Google docs are marked data-target="doc" /
  // data-is-doc-name="true"; folders are not, so this is what keeps us from
  // ever hijacking a folder's double-click (which navigates into it).
  function isDocRow(el) {
    if (!el || !el.getAttribute) return false;
    const target = el.getAttribute("data-target");
    if (target !== null) return target === "doc";
    return el.getAttribute("data-is-doc-name") === "true";
  }

  // A stable identity for a row, so we can recognise two clicks on the "same"
  // file even though the picker replaces the element between clicks.
  function rowId(el) {
    return (el && el.getAttribute && el.getAttribute("data-id")) || null;
  }

  // Act on a confirmed "open this file" gesture. Returns true if we took over.
  //   - attachable file -> insert as attachment;
  //   - native Google doc (attach disabled, link enabled) -> suppress, so no
  //     stray Drive link;
  //   - otherwise -> leave to Gmail.
  function confirmDocRow(event) {
    const footer = findFooter(document);
    dbg("confirmDocRow", {
      type: event.type,
      footer: !!footer,
      hasLink: !!(footer && footer.linkBtn),
      hasAttach: !!(footer && footer.attachBtn),
      attachDisabled: footer && footer.attachBtn ? isDisabled(footer.attachBtn) : null
    });
    if (!footer || !footer.linkBtn) return false;
    const attachBtn = footer.attachBtn;

    if (attachBtn && !isDisabled(attachBtn)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      synthesizing = true;
      try {
        dbg("confirmDocRow -> clicking attach");
        attachBtn.click();
      } finally {
        setTimeout(() => {
          synthesizing = false;
        }, 0);
      }
      lastConfirmAt = Date.now();
      return true;
    }
    if (!isDisabled(footer.linkBtn)) {
      // Native Google doc: suppress so a link is not inserted by accident.
      dbg("confirmDocRow -> suppress (native doc)");
      event.preventDefault();
      event.stopImmediatePropagation();
      lastConfirmAt = Date.now();
      return true;
    }
    return false;
  }

  // --- double-click, reconstructed from click events ---
  //
  // The picker re-renders a file tile when it becomes selected, so the browser
  // often never fires a native `dblclick` on a single stable element. We detect
  // a double-click ourselves: two clicks on the same row (by data-id) within a
  // short window. The first click is left alone (it selects the file); the
  // second is taken over.
  const DOUBLE_MS = 500;
  let lastClickId = null;
  let lastClickAt = 0;
  let lastConfirmAt = 0;

  function eligible(target) {
    if (synthesizing) return null;
    if (!GDAF.current.overrideDefaultAction) return null;
    if (!target) return null;
    // Act only when the gesture is inside a document/file row. This naturally
    // excludes the footer buttons (they aren't inside a role="option" row), so
    // we don't need a separate button guard -- and, crucially, it still fires
    // when a click lands on an inner clickable element within a file tile
    // (the tiles contain their own [role="button"] hit areas).
    const row = closestRow(target);
    if (!isDocRow(row)) return null;
    return row;
  }

  function onClick(event) {
    const row = eligible(event.target);
    dbg("onClick", {
      targetTag: event.target && event.target.tagName,
      eligibleRow: !!row,
      override: GDAF.current.overrideDefaultAction,
      synthesizing
    });
    if (!row) {
      lastClickId = null;
      return;
    }
    const id = rowId(row) || "(row)";
    const now = Date.now();
    const isSecond = id === lastClickId && now - lastClickAt < DOUBLE_MS;
    dbg("onClick row", { id, lastClickId, dt: now - lastClickAt, isSecond });

    if (isSecond) {
      lastClickId = null;
      lastClickAt = 0;
      confirmDocRow(event); // preventDefault/stop happen inside on takeover
    } else {
      // First click: remember it, let selection happen normally.
      lastClickId = id;
      lastClickAt = now;
    }
  }

  // Fallback + suppressor: if a native dblclick does fire, either finish the
  // job (if the click path somehow missed it) or neutralise Gmail's built-in
  // dblclick-to-link when we already handled it via clicks.
  function onDblClick(event) {
    dbg("onDblClick", {
      targetTag: event.target && event.target.tagName,
      recentlyConfirmed: Date.now() - lastConfirmAt < 700,
      eligibleRow: !!eligible(event.target)
    });
    if (Date.now() - lastConfirmAt < 700) {
      // Already handled via the click path; just stop Gmail's own dblclick.
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (!eligible(event.target)) return;
    confirmDocRow(event);
  }

  function onKeyDown(event) {
    if (event.key !== "Enter") return;
    // Leave modified Enter (Ctrl/Cmd/Alt/Shift+Enter) to the app.
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (!eligible(event.target)) return;
    confirmDocRow(event);
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
    // suppress them. We reconstruct double-click from `click` (the picker
    // re-renders tiles between clicks, so native `dblclick` is unreliable);
    // `dblclick` stays as a fallback/suppressor, and Enter confirms too.
    document.addEventListener("click", onClick, true);
    document.addEventListener("dblclick", onDblClick, true);
    document.addEventListener("keydown", onKeyDown, true);
    dbg("listeners attached in frame", location.href);

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
