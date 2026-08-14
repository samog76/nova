# Nova — a Chromium Browser

A minimal but complete desktop web browser built on the real Chromium engine
via [Electron](https://www.electronjs.org/). Not a wrapper around a single
website — it has its own tab strip, address bar, and navigation, and renders any
site with the same engine that powers Google Chrome.

## Preview

<p align="center">
  <img src="Screenshot%202026-06-18%20at%2009.52.03.png" width="48%" />
  <img src="Screenshot%202026-06-18%20at%2009.52.27.png" width="48%" />
</p>

## Design — "Aurora Glass"

A distinctive dark theme on a midnight base (`#0a0e27`) with aurora-tinted glow,
frosted-glass surfaces, and a cyan→violet→pink aurora gradient used as the
signature accent:

- A pulsing aurora **brand orb**.
- Tabs as glass pills with a **flowing aurora indicator** sliding under the
  active tab.
- A pill **omnibox** that lights up with an animated aurora focus ring.
- A thin **aurora loading bar** with an indeterminate shimmer while a page loads.
- Crisp inline **SVG icons** (no emoji/entity glyphs), visible focus, and full
  `prefers-reduced-motion` support.

Design direction was generated with the `ui-ux-pro-max` design-intelligence
skill (dark developer-tool palette + high-contrast accessible accents).

## Start page

New tabs and the Home button open a custom local **Nova start page**
([ui/home.html](ui/home.html)) — not Google. It has the aurora wordmark, a
self-contained search box (URLs go direct, everything else searches Google), and
quick-link tiles. The address bar shows empty on the start page.

## Internal `nova://` pages

Nova has its own built-in pages, reachable from the address bar (`nova://settings`),
the toolbar **⋮ menu**, the **Tools** menu, the start-page links, or shortcuts:

| Page | Address | What it does |
| --- | --- | --- |
| **Settings** | `nova://settings` (`Cmd/Ctrl+,`) | Default search engine, Home-button target (Nova start page or a custom URL), reduce-motion, ad-blocker toggle, reset. Saved to `userData/nova-settings.json` and applied app-wide. |
| **Ad Blocker** | `nova://adblock` (`Cmd/Ctrl+Shift+B`) | Control panel: on/off, live blocked count, cosmetic toggle, filter level, per-site allowlist. |
| **Extensions** | `nova://extensions` (`Cmd/Ctrl+Shift+E`) | Load, enable/disable, and remove **real unpacked Chrome extensions** via Electron's `session.loadExtension`. Enabled ones reload on startup. |
| **History** | `nova://history` (`Cmd/Ctrl+Y`) | Session browsing history grouped by day, with search and clear-all. |
| **About** | `nova://about` | Live Nova / Chromium / Electron / Node / V8 versions. |

These pages render in sandboxed tabs; a guarded `nova-preload.js` only exposes the
`window.nova` bridge (history, settings, extensions, versions) on Nova's own pages,
never on regular websites.

## Keyboard shortcuts

Shortcuts are handled via Electron's `before-input-event`, so they work whether
focus is in the page or the address bar. A native menu bar mirrors them (and
provides macOS clipboard support). `CmdOrCtrl` = Cmd on macOS, Ctrl elsewhere.

| Action | Shortcut |
| --- | --- |
| New tab | `CmdOrCtrl+T` |
| Close tab | `CmdOrCtrl+W` |
| Reopen closed tab | `CmdOrCtrl+Shift+T` |
| New window | `CmdOrCtrl+N` |
| Close window | `CmdOrCtrl+Shift+W` |
| Next / previous tab | `Ctrl+Tab` / `Ctrl+Shift+Tab`, `Ctrl+PgDn` / `Ctrl+PgUp` |
| Jump to tab 1–8 / last tab | `CmdOrCtrl+1`…`8` / `CmdOrCtrl+9` |
| Focus address bar | `CmdOrCtrl+L`, `F6`, `Alt+D` |
| Reload / force reload | `CmdOrCtrl+R` or `F5` / `CmdOrCtrl+Shift+R` or `Shift+F5` |
| Stop | `Esc` |
| Back / forward | `Alt+←`/`→` (macOS `Cmd+←`/`→`, also `Cmd+[`/`]`) |
| Home | `Alt+Home`, `CmdOrCtrl+Shift+H` |
| Find in page | `CmdOrCtrl+F` |
| Find next / previous | `CmdOrCtrl+G` or `F3` / `CmdOrCtrl+Shift+G` or `Shift+F3` |
| Zoom in / out / reset | `CmdOrCtrl+=` / `CmdOrCtrl+-` / `CmdOrCtrl+0` |
| Print | `CmdOrCtrl+P` |
| View source | `CmdOrCtrl+U` |
| Developer tools | `F12`, macOS `Alt+Cmd+I`, others `Ctrl+Shift+I` |
| Full screen | `F11` (macOS `Ctrl+Cmd+F`) |
| Edit (in address/find fields) | `CmdOrCtrl+Z/Y/X/C/V/A` |

## Built-in ad blocker

Nova ships with a built-in **ad & tracker blocker** — no extension needed. It uses
the [Ghostery/Cliqz adblocker engine](https://github.com/ghostery/adblocker) with the
**EasyList + EasyPrivacy** filter lists (the same lists Adblock Plus uses):

- **Network blocking** — every request on the shared session is matched and cancelled
  or neutered (e.g. Google Analytics is swapped for a harmless stub).
- **Cosmetic filtering** — per-site CSS hide rules and scriptlets are injected into
  each page to remove ad containers and defuse same-origin ads.

The compiled engine is cached per level to `userData/adblock-<level>.bin`, so it works
offline after the first launch.

### Control panel — `nova://adblock` (`Cmd/Ctrl+Shift+B`)

A dedicated panel with a master on/off switch and live blocked count, a cosmetic-filtering
toggle, a Standard/Complete filter-list selector (Complete adds anti-annoyance & cookie
lists), a counter reset, and a per-site **allowlist** for sites you want to load unblocked.

> **YouTube:** its video ads come from the same servers as the videos themselves, so
> they're an ongoing cat-and-mouse game. Cosmetic filtering and scriptlets help, but some
> YouTube ads may still get through — that's expected even for dedicated blockers.

## Features

- **Built-in ad/tracker blocking** — EasyList/EasyPrivacy filtering on by default.
- **Multiple tabs** — open, switch, and close tabs; each tab is an isolated,
  sandboxed Chromium `WebContentsView`.
- **Omnibox** — type a URL or a search query (queries go to Google). Bare
  domains like `example.com` auto-upgrade to `https://`.
- **Navigation** — back, forward, reload/stop, and a home button.
- **Live tab UI** — per-tab title, favicon, and a loading spinner.
- **New-window handling** — `target="_blank"` / `window.open` open as new tabs.
- **Keyboard shortcuts** — `Cmd/Ctrl+T` new tab, `Cmd/Ctrl+W` close tab,
  `Cmd/Ctrl+R` reload, `Cmd/Ctrl+L` focus the address bar.

## Run

```bash
npm install   # one-time: downloads the Chromium/Electron binaries
npm start
```

## Build a macOS app + installer

Package Nova into a `Nova.app` and a shareable `.dmg`:

```bash
bash build/package-mac.sh arm64        # Apple Silicon — verified working → dist/Nova-1.0.0-arm64.dmg
bash build/package-mac.sh universal    # Apple Silicon + Intel (experimental, see note)
```

> The **arm64** build is tested and stable. The **universal** build currently exits a few
> seconds after launch (an asar-integrity quirk introduced by the `@electron/universal`
> merge under Electron 31) — needs the integrity fuse disabled before it's shippable. Use
> arm64 unless you specifically need Intel support.

[`build/package-mac.sh`](build/package-mac.sh) builds the unpacked bundle with
`electron-builder` (configured in [`electron-builder.yml`](electron-builder.yml)),
**ad-hoc code-signs** it (so it launches on Apple Silicon), then assembles the `.dmg`
(drag-to-`/Applications` layout) by hand. The app icon comes from
[`build/make-icon.py`](build/make-icon.py) → [`build/make-icns.sh`](build/make-icns.sh).

### Opening it on another Mac (important)

The build is **not signed with an Apple Developer ID and not notarized** (that needs a
paid Apple account), so Gatekeeper will block it on first launch. To run it on a test
Mac, open the `.dmg`, drag **Nova** to Applications, then **either**:

- **Right-click** `Nova.app` → **Open** → **Open** (only needed the first time), **or**
- clear the download quarantine from a terminal:
  ```bash
  xattr -dr com.apple.quarantine /Applications/Nova.app
  ```

For frictionless installs (no warnings) you'd need an Apple Developer ID to sign and
notarize the app — say the word and I can wire that into the build.

## Project layout

| File                  | Role                                                              |
| --------------------- | ----------------------------------------------------------------- |
| `electron-builder.yml`| Packaging config (appId, icon, dmg layout) for `build/package-mac.sh`. |
| `build/`              | Icon generator + `package-mac.sh` macOS app/dmg build script.    |
| `main.js`             | Main process: window, tab lifecycle, navigation, settings, history, extensions, IPC. |
| `preload.js`          | Secure `contextBridge` API exposed to the chrome UI.              |
| `nova-preload.js`     | Guarded bridge (`window.nova`) for internal `nova://` pages only. |
| `ui/index.html`       | The browser chrome: tab strip + toolbar + overflow menu.         |
| `ui/styles.css`       | Dark-theme styling for the chrome.                                |
| `ui/renderer.js`      | Chrome UI logic; talks to the main process over IPC.              |
| `ui/home.html`        | The Nova start page (new tabs / Home).                            |
| `ui/internal.css`     | Shared Aurora-Glass styling for the `nova://` pages.              |
| `ui/settings.html`    | `nova://settings`.                                                |
| `ui/adblock.html`     | `nova://adblock` — ad-blocker control panel.                      |
| `ui/extensions.html`  | `nova://extensions`.                                              |
| `ui/history.html`     | `nova://history`.                                                 |
| `ui/about.html`       | `nova://about`.                                                   |

## Architecture

A single `BaseWindow` hosts stacked `WebContentsView`s:

- One **chrome view** (top, fixed height) renders the tab strip and toolbar from
  `ui/`.
- One **tab view per open tab** renders actual web content below the chrome.
  Only the active tab's view is visible; the main process resizes them on every
  window resize.

The chrome UI never touches Node or web content directly — it sends commands
(`navigate`, `back`, `new-tab`, …) and receives state events (`tab:state`,
`tab:favicon`, …) through the `preload.js` bridge with context isolation on.

## The `ELECTRON_RUN_AS_NODE` crash (fixed)

If you launch from a shell where `ELECTRON_RUN_AS_NODE=1` is set, Electron starts
in plain-Node mode: the GUI APIs (`app`, `ipcMain`, …) are `undefined` and the
app used to crash with `TypeError: Cannot read properties of undefined`.

`main.js` now detects this at startup (`require('electron')` returns a path
string instead of the API object) and transparently re-launches the real
Electron runtime with a cleaned environment, so `npm start` just works either
way. Renderer console errors are also forwarded to the terminal for easier
debugging.
