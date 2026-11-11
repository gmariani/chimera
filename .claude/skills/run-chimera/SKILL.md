---
name: run-chimera
description: Run, start, drive and screenshot Chimera in a browser. Use when asked to open a file in the running app, check a preview or other UI change in the real app, click through it, take screenshots, or look for errors in the browser console.
---

Chimera is a browser app (Vite, React). To check it as a user would, start the dev server and drive headless Chromium
with `.claude/skills/run-chimera/driver.mjs`, which reads one command a line from stdin. Paths below are relative to the
repo root.

## Prerequisites

Chromium at `/usr/bin/chromium` (set `CHROMIUM` for another), and the project's packages: Playwright is a devDependency
(`playwright-core`, which brings no browsers of its own).

```bash
npm install
```

## Run (agent path)

Start the dev server in the background, and wait for it to answer:

```bash
(lsof -ti:5173 -sTCP:LISTEN | xargs -r kill) 2>/dev/null
nohup npm run dev -- --port 5173 --strictPort > ~/.cache/chimera/vite.log 2>&1 &
timeout 60 bash -c 'until curl -sf http://localhost:5173 >/dev/null; do sleep 1; done' && echo up
```

Then pipe it a script. This one opens Dune II's SOUND.PAK (the installed copy, see `npm run test:setup`), goes into a
music file, plays it, opens a sequence from its contents, and goes back:

```bash
node .claude/skills/run-chimera/driver.mjs <<'EOF'
open samples/westwood/dune II/SOUND.PAK
entry DUNE1.XMI
waitfor .music-timeline
tab Preview
text .music p
click .music button[aria-label="Play"]
wait 2000
text .music-clock
scroll .music
ss xmi-playing
click .music button[aria-label="Pause"]
entry DUNE1-06.mid
waitfor .music-timeline
text .music-clock
ss mid
crumb DUNE1.XMI
tab Preview
waitfor .music-timeline
errors
EOF
```

It prints what `text`, `eval` and `errors` find, and where screenshots went. It exits 1 at the first command that fails,
with a screenshot of that moment in `failure.png`. **Look at the screenshots**: `Read` them.

Screenshots: `~/.cache/chimera/shots/` (set `SHOTS` for another). Server log: `~/.cache/chimera/vite.log`.

| command | what it does |
|---|---|
| `open <path>` | Opens a file from disk, as the Open button does. |
| `entry <name>` | Opens a file from the Contents tab, by its name (switches to the tab first). |
| `tab <label>` | Picks a tab: Preview, Contents, Structure, Links... |
| `crumb <name>` | Goes back up the breadcrumb to that file. |
| `waitfor <selector>` | Waits (up to 60 s) for it to appear. |
| `wait <ms>` | Waits. |
| `click <selector>` | Clicks the first match. |
| `text <selector>` | Prints the first match's text. |
| `eval <js>` | Prints what the expression gives, run in the page. |
| `scroll <selector>` | Brings it into view. |
| `ss <name>` | Screenshots what's in view to `<name>.png`. |
| `errors` | Prints what the page logged as errors, or threw. |

Stop the server when done:

```bash
lsof -ti:5173 -sTCP:LISTEN | xargs -r kill
```

## Test

```bash
npm test
```

The unit tests don't touch the page; this skill is for what only the page shows.

## Gotchas

- **A file comes back on the tab it was last on.** Going back up the breadcrumb to a file you left from its Contents
  shows Contents again, not Preview: run `tab Preview` before waiting for anything in a preview.
- **Screenshots show only what's in view** (1400 × 1000). Previews often start below a long outline: `scroll` to them first.
- **Headless Chromium has no sound device**, but audio still plays as far as the page can tell: `currentTime` advances,
  so a moving clock (`text .music-clock`) is the check. Nothing can be heard.
- **"Play" buttons are on each music preview**: `click .music button[aria-label="Play"]` takes the first preview's.
  A preview with no sound has its button disabled; pick it by its place, not the first enabled one, or you'll be
  watching the wrong preview.
- **Opening a big file takes seconds**: everything is read in a worker when it's opened (a Dune II XMI renders minutes
  of music). `waitfor` the part you need rather than a fixed `wait`.

## Troubleshooting

- **`page.waitForSelector: Timeout 60000ms exceeded`** after `crumb`: the file came back on another tab (see Gotchas).
  `failure.png` shows which.
- **`Cannot find package 'playwright-core'`**: the project's packages aren't installed; run `npm install`.
