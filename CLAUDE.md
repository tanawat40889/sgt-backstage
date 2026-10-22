# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

SGT Backstage: a browser-based show controller for projectors (Preview/Live switching of layered scenes, playlists, PDF slides, per-team cue countdowns, a phone remote). The UI is in Thai.

## Commands

No build step, no dependencies, no test suite. Plain HTML/CSS/JS served as static files.

```bash
python3 -m http.server 5184 -d .     # run locally → http://localhost:5184 (preview config "sgt-backstage")
node --check app.js                  # the only automated check: syntax
git push origin main                 # deploy → https://tanawat40889.github.io/sgt-backstage/
```

After a push, confirm the deploy by comparing `shasum` of the served file with the local one. GitHub Pages has once failed to start a build on its own; an empty commit pushed to `main` kicked it off.

Requires Chrome or Edge on desktop (File System Access API). Third-party code is loaded from CDNs only when needed: PeerJS (unpkg), qrcode-generator (unpkg), pdf.js (cdnjs), Noto Sans Thai (Google Fonts). The app must keep working when these fail to load.

## Architecture

### Pages
- `index.html` + `app.js` + `style.css`: the control page. Almost all logic lives in `app.js`, organised in `/* ---------- section ---------- */` blocks.
- `output.html`: the projector window. It has no logic of its own: the control page opens it with `window.open`, the page calls `opener.outputReady(window)`, and from then on the control page builds DOM directly inside it (`stages.out`).
- `countdown.html`, `remote.html`: standalone pages for other devices. They only talk to the control page through the "room" (below).

### Project = a folder on disk
A project is a folder holding `<name>.sgtbs` (JSON) and `media/`. Files are referenced by relative path (`media/x.png`) and turned into blob URLs at load (`urls` map). Older `.sgtobs` files are opened by copying them to `.sgtbs`; the old file is never modified. `normalize()` upgrades older JSON shapes on load (v1 single-source shots → `sources[]`, 3 layers).

Data model: `layers[].shots[].sources[]`. The UI calls a shot a **scene**; the code still says `shot`. Source `type` is one of `image | video | audio | camera | mic | screen | pdf`. Picture sources carry geometry in canvas pixels (`x y w h`, canvas 1920×1080) plus `crop`/`feather` (percent), `diag`, `radius`. Shot-level options: `playlist`, `cross`, `plLoop`, `hotkey`, `abbr`, `cues`; `layer.clearHotkey` is the shortcut of the layer's empty ("ว่าง") tile. Saves go through `save()` / `saveSoon()` (debounced for keystroke-level edits).

### Stages
`setStage(stage, ids, ms, mode)` diffs a per-layer selection into a stage; `mode` is `pv | live | out`. Each stage builds **its own copy** of every visible source with `shotNode()`, so Preview, Live and Output are three independent DOM trees: anything with state (video position, PDF page) has to be pushed to every copy (see `seekTo`, `setPage`, `regeom`). Rules that follow from this: sound plays only from `live`; Preview holds videos on a still frame; Output is always muted.

Source DOM is `.src > .view > media`. `applyGeom()` places it: the box uses canvas-pixel percentages, `.view` is the cropped picture sized with CSS container units, soft edges are CSS masks built by `fadeStops()`.

### Audio
Each live media element → its own gain (`_gain`, used by playlist crossfades) → the shot node's bus (`_bus`, used by Fade transitions) → `master` → speakers and two analysers (the meter). `runPlaylist()` sequences a shot's audio files and returns `{ jump(k) }`.

### Heartbeat
`countdownTick()` runs every 200 ms and drives everything time-based: the countdown, the seek bar (`transportTick` → `tp`), the Preview/Live song lists, and broadcasting to other devices (`{ d, p }` every tick, `{ st }` via `sendState()` only when changed). Many tests call it directly because timers are throttled in a hidden tab.

### Room (other devices)
A 6-digit code in `localStorage`. Two transports carry the same messages: `BroadcastChannel('sgtobs-countdown-<room>')` within one browser, and PeerJS (peer id `sgtobs-<room>`) across devices. Remote commands are `{ cmd, n }`; a remote in the same browser arrives over both transports, so `onRemote()` drops repeated `n`. Commands only act on scene/source ids that really exist in the project. Anyone with the code can control the show.

### Identifiers that still say "sgtobs"
IndexedDB `sgtobs` (recent folder handles), the room key and channel names, the PeerJS prefix and the picker ids keep the old name on purpose: renaming them would wipe users' recent-folder lists and change their room codes. `sessionStorage['sgtbs-open']` reopens the current project after a refresh, per tab.

## Conventions

- The product was renamed away from "Wirecast". Keep Wirecast's vocabulary out of the UI (shot → scene, Clear Layer → ว่าง, Smooth → Fade, the GO button).
- Bars and panels have fixed heights so the screens never jump while working; overflowing content scrolls sideways instead of wrapping.
- Destructive actions go through `askDelete()`; general confirmations through `ask()`.
- Comments explain why, not what.
- Removed on purpose; do not bring back without asking: Live-to-YouTube with a local Node/ffmpeg helper (commit `e86b5f4`, reverted in `4c6540a`), and a picture monitor on the remote.

## Verifying changes in the browser preview

- No real folder picker is available to an agent. Use the browser's private file system instead: `const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('Demo', { create: true }); await openFolder(d);`, and stub `window.showDirectoryPicker` to test the pick flows.
- Make test media in the page: PNGs from a canvas, WAV bytes by hand, a PDF by hand. Delete the test folder and its recent-list entry afterwards.
- The preview tab is usually hidden: `requestAnimationFrame` and `ResizeObserver` may not run, and screenshots can show a stale frame. Measure the DOM rather than trusting a screenshot.
- The preview browser caches `index.html` aggressively. After editing, run `fetch(f, { cache: 'reload' })` for `./` and each changed file, then navigate again.
