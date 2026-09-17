# Gmail Drive: Always Attach

A small Chrome (Manifest V3) extension that flips Gmail's Google&nbsp;Drive
picker so **"Insert as attachment"** is the default action instead of
**"Insert as Drive link"** — because most of the time you want to send the
actual file, not a link to it.

It does two things when the Drive picker's footer appears:

1. **Swaps the two buttons** — the *attachment* button takes the primary,
   default‑styled slot (and the correct Material styling), and the *link*
   button becomes the secondary option. The link option stays fully
   functional for the exceptions where you really do want to share a link.
2. **Overrides the confirm gesture** — double‑clicking a file, or selecting it
   and pressing **Enter**, inserts it as an **attachment** rather than a link.

If a selected file can only be linked (e.g. a native Google Doc/Sheet, which
Gmail can't attach as a file), the extension keeps both buttons but leaves the
**attachment button disabled in the primary slot**, so the link button is
demoted to the secondary style and is far less likely to be clicked by
accident. In that case double‑click / Enter on the file does **nothing**
(rather than silently inserting a link) — you insert a link only by clicking
"Insert as Drive link" on purpose. Folders are never affected: double‑clicking
a folder still navigates into it.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top‑right).
3. Click **Load unpacked** and select this folder.
4. Open Gmail, compose a message, and click the Google&nbsp;Drive icon. The
   attachment button is now the highlighted default; double‑clicking a file
   attaches it.

Works in any Chromium‑based browser that supports MV3 (Chrome, Edge, Brave,
Arc, …).

## Options

Open the extension's **Options** (via `chrome://extensions` → *Details* →
*Extension options*, or the puzzle‑piece menu). You can:

- Turn the **button swap** on/off.
- Turn the **double‑click / Enter → attachment** override on/off.
- Adjust the **label‑matching patterns** if your Gmail is not in English
  (see below).

Settings are stored in `chrome.storage.sync`, so they follow your Chrome
profile and apply live without reloading Gmail.

## How it works

Gmail renders the Drive picker inside a cross‑origin `<iframe>` served from
`docs.google.com` / `drive.google.com`. This extension's content script matches
only those domains and is declared with `all_frames: true`, so Chrome injects
it into that nested picker frame (a content script is injected into any frame
whose URL matches, regardless of the parent page's origin) — the only place the
buttons live. It deliberately does **not** run in the top `mail.google.com`
frame, so it never touches the compose toolbar's own "Attach files" / "Insert
link" buttons; it also bails out unless it is running inside a frame, to stay
clear of full‑page Docs/Drive.

Google's CSS class names are obfuscated and change often, so the extension
**never relies on them**. Instead it:

- Locates the two buttons by their visible text / `aria-label`
  (matching the words *attachment* and *link*, case‑insensitively).
- Swaps them by exchanging their **DOM position** and their **`class`
  attribute** — each button keeps its own label and click handler but adopts
  the other's slot and styling. This is why the (now‑default) attachment
  button gets the exact primary styling Gmail would have given the link
  button.
- Uses a `MutationObserver` to re‑apply the swap whenever the picker
  re‑renders, and a capture‑phase `dblclick` listener to intercept
  double‑clicks before Gmail's own handler runs.

Because everything keys off the button *text*, adapting to another language
is just a matter of changing two patterns in the options — no code changes.

### Non‑English Gmail

The defaults match the English words `attach` and `link`. For other
languages, set the two **label‑matching patterns** in the options to
(case‑insensitive) regular expressions that appear in each button's label,
for example:

| Language | Attachment pattern | Link pattern |
| --- | --- | --- |
| English  | `attach`           | `link`       |
| German   | `anhang\|anhängen` | `link`       |
| French   | `pièce jointe`     | `lien`       |
| Spanish  | `adjunt`           | `enlace\|vínculo` |

(Adjust to match exactly what your Gmail shows.)

## Project layout

```
manifest.json          MV3 manifest
src/settings.js        Shared defaults + chrome.storage loader (runs first)
src/picker.js          Button swap + double-click override (the core logic)
options/               Options UI (html/css/js)
icons/                 Extension icons (generated, see scripts/)
```

## Limitations / notes

- The extension deliberately touches only the two footer buttons and the
  confirm‑gesture (double‑click / Enter) behaviour; it makes no network
  requests and stores nothing beyond your preferences.
- If Google significantly restructures the picker, the swap may stop
  applying. Because it matches on visible text, the usual fix is just
  updating the label patterns in the options rather than the code.
- The confirm‑gesture override triggers the *attachment* button for the file
  you double‑clicked / pressed Enter on. If you have a mix selected, use the
  buttons directly.
- File vs folder is told apart by the picker's `data-target="doc"` marker on
  each row. If Google renames that marker, the override will simply stop firing
  (falling back to Gmail's own behaviour) rather than misbehaving — folder
  navigation always wins.

## Development

The icons are generated from a dependency‑free Python script:

```
python3 scripts/make_icons.py
```

There is no build step — the files in this repo are loaded directly as an
unpacked extension.

## License

MIT — see [LICENSE](LICENSE).
