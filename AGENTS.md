# AGENTS.md

Notes for anyone, human or agent, changing Chimera. The README covers what the app does and how to add a format; this file covers how to work on it well.

## What Chimera is for

Chimera opens a file and explains it: what it is, how it's put together, and what's inside, down to the byte. It's three tools in one:

- **A way to learn.** Every part of a file is named and explained, so someone curious about a format can see how it works.
- **A way to explore.** Archives open into their files, pictures and sounds play, and anything can be pulled out and saved.
- **A way to investigate.** Files aren't always what they claim. Chimera is used on malware and on files built to crash the programs that read them, so it says when something doesn't fit, and never trusts a file to be honest about itself.

Each reader should **explain as much about the file as it can**. Name every field, say what its value means, call out what's unusual, and mark every byte. Be detailed, but **never at the expense of readability**: the person reading may be new to the format, or tired, in the middle of an investigation. A clear sentence beats a complete but dense one.

## Writing for the person using it

Everything a reader shows (titles, summaries, field names, notes, warnings) is written for a person, not for a programmer.

- Plain words. Say what a value means, not only what it is: "Where the file starts." rather than "u32 offset".
- A warning says what's wrong and why it matters: "Frame 3 decompresses to more than the 37 bytes the header has the game set aside: the game would write past its buffer."
- Numbers are formatted for reading: `toLocaleString('en-US')` for counts, `bytesLabel()` for sizes.
- US spelling everywhere, in code and in text: color, gray, center, behavior.
- When a file breaks the spec in a way real files do (a known quirk of the game's own tools), accept it quietly and say why in a comment. A warning on every real file teaches people to ignore warnings.

## The trust boundary is the file

There are no APIs and no servers here. What crosses the trust boundary is the bytes of the file, and they can be hostile. Every value read from a file is a claim until checked against the file itself:

- **Throw** when the bytes aren't the format at all, with a message saying what doesn't fit. The next likely format gets tried, and the message is shown.
- **Warn** about anything else the spec doesn't allow: sizes that disagree, values out of range, a missing end marker, data that never shows.
- **Check sizes, counts and offsets before using them.** Use `src/core/limits.ts` (`checkCount`, `checkBytes`, `pixelBuffer`, `Budget`) before allocating, and `src/core/math.ts` (`minOf`, `maxOf`, `append`) instead of spreading file-sized lists into arguments.
- **Bound every loop** by the data, never only by a marker the file may not have.
- **Mark every byte** in `fields`. Set `end` where the format's data ends, so anything after it is flagged by the shared checks in `src/formats/inspect.ts`.
- **Don't guess** at what a disguised file hides. Say it isn't what it claims, and let the person look.

The README's "Adding a format" section has the full list. Two smaller boundaries matter too:

- **The worker and the page.** All parsing happens in the Web Worker (`src/engine`). Results must survive `postMessage`. Nothing on the page parses or sniffs a file's bytes; the page asks the worker.
- **Files the user adds for help**, such as name lists and companion files. Treat them as data, as strictly as the file being inspected.

## Code conventions

- **TypeScript, strict.** `npm run typecheck` must pass.
- **Named exports.** The one exception is a format's parser: it's the module's default export, because the registry in `src/formats/index.ts` loads it on demand as `m.default`. Oxlint enforces this (`import/no-default-export`, off only under `src/formats/`).
- **No barrel files.** Import from the module that defines the thing. `src/engine/index.ts` isn't a barrel: it creates the app's single engine and re-exports the client types that go with it. Oxlint enforces this too (`oxc/no-barrel-file`).
- **Readers don't render.** A reader turns bytes into `fields`, `entries` and `preview` data (`src/core/types.ts`). The UI stays generic and knows no formats.
- **Ask before adding a dependency.** Decoders are written here (inflate, PNG, LCW, LZW), and that's deliberate: they can be made strict, and they can report what they found wrong.
- **Formatting is Prettier's** (`.prettierrc.json`, the same settings as the owner's other projects except a 200-character line). Run `npm run format` before you finish; don't format by hand against it.
- **Comments explain the format, not the code.** Each reader starts with a short description of the format, the games or programs that use it, and a link to the spec it follows. Quirks get a comment saying where they come from (a game's own code, real files, a reference decoder).
- **The look** is an industrial blueprint: deep blue ground, thin pale lines, a faint drafting grid, square corners, one chartreuse accent for focus and selection. Pages are built from frames and sections with numbered section bars. See the top of `src/styles.css`, and keep new UI in that style.

## Which tests are worth writing

Tests should prove a reader is right and stays right, not restate its code.

- **Ground truth from outside.** Compare against a reference: FFmpeg's decoded samples, a worked example from the spec, a real file's known contents. A reader checked only against itself proves nothing.
- **Round trips.** For a decoder, encode with a small, plain encoder in the test (see `src/formats/westwood/encoders.test-util.ts`) and check the decoder gives it back.
- **One test for each warning and each refusal**, with the smallest file that triggers it, and the message checked well enough to show it's the right one.
- **Generated samples.** `src/testing/samples.ts` makes a small, valid file of each format that can be made from scratch, written to `samples/generated/` (`npm run samples`) and committed. When a format can be made this way, add it there: it's then tested on every machine.
- **Real files when they're there.** Tests over game files get the game's folder from `gameDir()` or `gameFile()` (`src/testing/game-data.ts`) and skip with `describe.skipIf(!folder)`. Never hardcode a path into `samples/`. They pass with no warnings, except for known quirks of the shipped files, which the test names.
- **Not worth writing:** snapshots of whole results, tests of the UI's pixels, and tests that only repeat what the implementation does.

## Before calling something done

Nothing is finished until it's checked. Run what applies, and say what you ran and what it showed:

1. `npm run typecheck`, `npm run lint` (Oxlint) and `npm run format:check` (Prettier).
2. `npm test`.
3. When a sniffer or the registry changed, run the game data and compare the count of each format in every archive with the code from before the change (`git stash`). A sniffer that suddenly claims other files fails silently: they just open as the wrong thing. Run vitest with `--silent=false --reporter=verbose` to see the counts.
4. When a reader or decoder changed, run `npm run fuzz`. Point it at game data when the format comes from there. It should report no findings.
5. Check new behavior on real files where they exist, not only on files a test builds. Say plainly when no real files were available.

Report what didn't pass, with the output. Don't round "mostly works" up to "works".

## Data and safety

- **Game files are never committed or copied into the repo.** They belong to EA, and freeware isn't permission to republish. They're read where they're installed: `npm run test:setup` says where each game is (saved to the gitignored `game-data.local.json`), and `npm run test:game-data` runs every file of the installed games through the readers. Only `samples/generated/` is committed from `samples/`.
- **Never run memory-heavy work uncapped.** The fuzzer caps each worker's memory (1.5 GB, no swap, via systemd) and time (10 s). An uncapped run once took down the editor.
- **Temporary scripts and output go in a scratch directory,** not the repo. A throwaway test inside `src/` gets deleted as soon as it's run.
- **Don't commit.** The owner reviews and commits changes.

## Where things are

- `src/formats/index.ts`: the registry (every format, its sniffer and how to load it).
- `src/formats/inspect.ts`, `src/formats/identify.ts`: the checks every file gets (claims against contents, data after the end, signatures, entropy).
- `src/formats/<format>/`, `src/formats/westwood/`: the readers and their sniffers.
- `src/core/`: bytes, limits, shared decoders and types.
- `src/engine/`: the parsing worker and the page's side of it.
- `src/components/`, `src/tabs/`, `src/lib/`: the UI.
- `src/testing/`: where the installed games are (`game-data.ts`), and the sample generator (`samples.ts`).
- `scripts/`: `npm run test:setup` and `npm run samples`.
- `fuzz/`: the fuzzer.

## References

Specs come first from the [ModdingWiki](https://moddingwiki.shikadi.net/) for game formats, and from the format's own specification otherwise. Where a spec is vague, a reference implementation (FFmpeg, the game's released source code) is the tiebreaker. Cite whichever was used.
