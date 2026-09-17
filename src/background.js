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
  try {
    console.log(
      "[gdaf-bg] connect tab",
      tabId,
      "frame",
      port.sender && port.sender.frameId,
      port.sender && port.sender.url,
      "ports now",
      set.size
    );
  } catch (e) {}

  port.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "confirm") return;
    let forwarded = 0;
    for (const other of set) {
      if (other === port) continue;
      try {
        other.postMessage({ type: "do-confirm" });
        forwarded++;
      } catch (e) {
        /* port gone; onDisconnect will clean it up */
      }
    }
    try {
      console.log(
        "[gdaf-bg] confirm from frame",
        port.sender && port.sender.frameId,
        "forwarded to",
        forwarded,
        "of",
        set.size - 1
      );
    } catch (e) {}
  });

  port.onDisconnect.addListener(() => {
    set.delete(port);
    if (set.size === 0) portsByTab.delete(tabId);
  });
});
