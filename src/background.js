/*
 * background.js (MV3 service worker)
 *
 * Relays "confirm" messages between the content scripts running in the Drive
 * picker's frames. The picker splits the file grid and the footer buttons into
 * separate sandboxed / opaque-origin iframes, so those frames cannot reach each
 * other via BroadcastChannel or direct DOM. They can, however, each open a
 * long-lived port to this service worker, which forwards a message from one
 * frame to the others in the same tab.
 *
 * This uses only runtime ports (initiated by the content scripts), so it needs
 * no host permissions and works regardless of frame origin/sandboxing.
 */

// tabId -> Set of connected ports
const portsByTab = new Map();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "gdaf") return;

  const tab = port.sender && port.sender.tab;
  const tabId = tab && typeof tab.id === "number" ? tab.id : null;
  if (tabId === null) return;

  let set = portsByTab.get(tabId);
  if (!set) {
    set = new Set();
    portsByTab.set(tabId, set);
  }
  set.add(port);

  port.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "confirm") return;
    // Forward to every other frame's content script in the same tab.
    for (const other of set) {
      if (other === port) continue;
      try {
        other.postMessage({ type: "do-confirm" });
      } catch (e) {
        /* port gone; onDisconnect will clean it up */
      }
    }
  });

  port.onDisconnect.addListener(() => {
    set.delete(port);
    if (set.size === 0) portsByTab.delete(tabId);
  });
});
