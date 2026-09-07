# EVE — working notes for Claude Code

Voice-first personal assistant for Umberto. Node 22 + TypeScript, ESM, no build
step in dev (tsx runs the sources).

**`AGENT.md` is the product spec — what EVE is and why.** Read it before any
change that touches behaviour, personality, the board, memory, the face, or the
Factory. This file is only the operational layer: commands, layout, and the
rules that are easy to break by accident.

## Commands

```
npm run eve        # typed REPL
npm run voice      # terminal voice mode
npm run face       # orb panel + /mind at http://127.0.0.1:3939
npm run brief      # morning brief on demand (no scheduled push since 2026-09-06 — the brief is the wake-up exchange)
npm test           # unit tests — ALWAYS via npm, never a bare `node --test`
npm run typecheck  # tsc --noEmit (covers src/ and scripts/)
npm run voicecheck # audio pipeline health, no mic needed
```

Before saying a change is done: `npm run typecheck && npm test`. Both, every
time. Report the actual output if either is red.

## Layout

- `src/core/` — the shared spine: agent loop, provider, registry, config,
  store, atomic writes, audit, conversations, notices
- `src/brain/` — system prompt, capabilities, loader. **Safety rails live in
  `prompt.ts` and are code-owned.**
- `src/tools/` — one file per tool. Three families now:
  - EVE-native: board, memory, skills, reminders, notes, projects, weather,
    research (best-of method + report delivery), perplexity, report
    (open_report_window → /report), conversations, factory
  - **macOS bridges** (osascript / system CLIs): `calendar.ts`,
    `calendar-write.ts`, `mail.ts`, `messages.ts`, `phone.ts` (FaceTime),
    `homekit.ts` (Shortcuts CLI)
  - **Capability parity with Hermes**: `delegate.ts` (claude-code / claude /
    chatgpt), `vision.ts` (Gemini), `web.ts` (fetch_url), `shell.ts`
    (run_command), `commitments.ts`, `ledger-write.ts`, `self-review.ts`
- `src/memory/` — extractor, recall, store (memories carry provenance:
  `source` user/extractor/core, `confirmed`, `verified`)
- `src/mind/`, `src/face/` — the 3D memory map and the orb UI (the face now
  has a text chat bar — Glaido dictation fills it — and a 🧠 button to /mind)
- `src/factory/`, `src/board/`, `src/design/`, `src/watch/`, `src/voice/`
- `desktop/` — the native macOS pieces: the app shell, the quick bar and its
  hotkey, and `ears/` (EVE Ears, the "Hey Eve" wake-word helper — Swift,
  its own `build.sh`, on-device speech, a face client over the WebSocket).
  **Ears is a fixed launcher stub plus a library on purpose**: macOS privacy
  keys an ad-hoc app on its executable's hash, so `EarsStub.swift` is built
  once and never rebuilt, and the logic in `Ears.swift` becomes
  `dist/EVE-Ears-lib/libEars.dylib`. Touching the stub means the two
  permission prompts again — say so in the commit.
- `scripts/` — real-model, real-filesystem checks. Typechecked on purpose: a
  broken reference here used to compile clean and only fail once someone paid
  to run it.
- `tests/` — `*.test.ts`, node:test, prose comments explaining what the test
  protects and how it broke before

State that is not code: `config.json` (never written at runtime),
`data/runtime.json` (the settings EVE changes about herself at runtime —
see `RuntimeSettings` in `src/core/config.ts`),
`.env` (keys), `data/` `memory/` `logs/` (gitignored, anchored to root).

## Invariants — these have all been broken before

1. **Nothing in `src/` may write to `memory/core/` or `brain/identity.md`.**
   Those are Umberto's to write. The protection is the *absence* of a write
   path, enforced by `tests/memory-boundaries.test.ts`.
2. **All mutable state goes through `STATE_ROOT`**, not `ROOT`. The suite
   refuses to run un-isolated (`tests/state-isolation.test.ts`) because it once
   wrote over real conversations, real memories and the real audit log —
   silently, and green the whole time.
3. **JSON state is written atomically** — use `writeFileAtomic` / `writeJson`
   from `src/core/atomic.ts`, never a bare `writeFileSync`.
4. **`config.json` is read-only at runtime.** Anything EVE changes about
   herself goes in `data/runtime.json` — add a field to `RuntimeSettings` and a
   setter beside `setStudiesDir`, then let `loadConfig` apply it over the
   `config.json` default. Enforced by `tests/config-boundaries.test.ts`.
5. **Personality edits go in `brain/identity.md`** (plain prose, re-read every
   turn, no restart). Never move personality into code, and never let a
   personality edit reach the safety rails.
6. **The Tier 6 gate**: outward or irreversible actions ask first. See
   "Boundaries" in AGENT.md before adding any tool that acts on the world.
   **`config.json` `confirmOverrides` can only turn a gate ON, never off** —
   a tool flagged in code stays flagged whatever the file says. This is
   enforced in `src/core/registry.ts` (`execute`): an `override === false`
   for a flagged tool is ignored. Do not "fix" this to make the file
   authoritative again — the file being weaker than the code is the point.
   **A standing yes** (`standingApproval` on a tool) pre-approves exactly
   one shape of one tool, in code, and only on a registry with a confirm
   hook — never the heartbeat's. There is one: the wake-up song
   (`src/tools/music.ts`). Adding or widening one is a gate change.
7. **AppleScript bridges: argv, never interpolation — and live-test everything.**
   Every osascript bridge (messages, calendar, calendar-write, mail,
   mail-write, phone) passes user-shaped values as osascript ARGUMENTS
   (`on run argv`), never as string-literal interpolation — arguments need
   no escaping and cannot inject script. The shared runner is
   `src/tools/applescript.ts`. AppleScript is a minefield — every one of
   these was hit LIVE, not in theory:
   - Reserved words that break silently: `sum`, `ref`, `date`, `message`,
     `accessory`, `content`, `read status` as a variable name. A variable
     named after one parses as something else (-2740/-2741 errors, or worse,
     no error at all).
   - Locale formats numbers: on this Mac `as integer` on an epoch renders
     as `1,7886672E+9` (Italian scientific notation), which Number()
     cannot parse — every calendar event silently vanished. Never pass big
     numbers across the bridge; pass date COMPONENTS (year, month, day,
     hours, minutes as small numbers).
   - Compound `whose` clauses need `its` on subsequent properties:
     `(every event of c whose (its start date ≥ f) and (its start date < t))`.
   - One-shot `launch` inside a script fails (-600) for closed sandboxed
     apps; use `ensureAppRunning()` (open -g + poll) before every script.
   - Deleting while iterating an `every event` collection shrinks the
     list mid-loop; collect first, delete after.
   - Setting `month` on the 31st rolls the date over; set `day to 1` first.
   The rule: **no AppleScript tool is done until you've watched it run
   against the real app** — the parser and the locale will surprise you in
   ways TypeScript cannot.
8. **The heartbeat re-reads state per check, never once per tick.**
   `tick()` and `checkDueReminders()` both `loadState()` immediately before
   their own `saveState()`. The single top-of-loop read was real: a due
   reminder's notified-ID was silently erased when the next check in the
   loop saved stale state over it.
9. **`.gitignore` paths stay root-anchored** (`/memory/`, not `memory/`) — a
   bare `memory/` once swallowed `src/memory/` and shipped three commits
   without their own code.
10. **`AGENT.md` is Umberto's document.** Refine it when he asks; never
   restructure, rewrite, or overwrite it on your own initiative. It is the
   source of truth the rest of the repo is checked against.
11. **EVE reports; she never self-modifies.** The weekly self-review
   (`self_review` heartbeat check, `src/tools/self-review.ts`) may propose
   improvements in a notice, but nothing in `src/` lets EVE write code,
   edit her own config, or change her own tools. If a change makes that
   possible, it is wrong regardless of how useful it looks. Code changes
   come from Umberto saying yes to a specific change — through a coding
   session, never through EVE herself.

## Conventions

- **Check `src/tools/` before adding a tool.** One file per tool, registered
  through `src/core/registry.ts`. Extend an existing one rather than minting a
  near-duplicate beside it.
- **Every tool registers in BOTH `src/cli.ts` AND `src/face/server.ts`** —
  and in the same order. The capabilities prose is derived, but the registries
  are hand-built lists, and a tool added to one and not the other is how the
  terminal and the face silently disagree about what EVE can do. The review
  caught exactly this with the calendar tools.
- **`Agent.runTurn` supports cancellation**: `Agent.cancel()` aborts the
  in-flight stream, and `FaceTurns.interrupt()` calls it. If you add a new
  turn path (a new surface, a new background flow), wire its stop into
  `cancel()` — an interrupted turn that keeps running to completion is a
  spent tool call and a reply nobody hears, arriving late.
- TypeScript `strict` + `noUncheckedIndexedAccess`. NodeNext resolution, so
  **imports carry the `.js` extension** (`../src/core/config.js`).
- Comments explain *why*, and name the failure the code is preventing. Match
  that density — the existing prose comments are the house style, not noise.
- Commit messages are a plain sentence saying what changed and what it means
  ("The boundary guard had two blind spots, and a real violation in both").
  No `feat:` / `fix:` prefixes.

## How Umberto wants the work done

- **Never ship a guard you haven't watched go red.** Introduce a fresh
  violation, see the test fail, then remove it. A guard that has only ever been
  green is not known to work.
- **If a change alters who can do what** — a permission, a gate, a boundary,
  even one line — surface it separately in the summary and mark it in the
  commit message. Don't let it ride along inside a larger change.
- **Paid calls are not free to retry.** Everything under `scripts/` reaches
  real models, and the design composer bills against a $10 cap. Fix the code
  and typecheck first; if the same run has already failed once, ask before
  spending another one on it.
- One question at a time. If a decision is routine, make the call, state the
  assumption, and keep going.
