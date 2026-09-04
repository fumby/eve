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
npm run brief      # daily briefing on demand
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
- `src/tools/` — one file per tool (board, memory, reminders, ledger, research…)
- `src/memory/` — extractor, recall, store
- `src/mind/`, `src/face/` — the 3D memory map and the orb UI
- `src/factory/`, `src/board/`, `src/design/`, `src/watch/`, `src/voice/`
- `scripts/` — real-model, real-filesystem checks. Typechecked on purpose: a
  broken reference here used to compile clean and only fail once someone paid
  to run it.
- `tests/` — `*.test.ts`, node:test, prose comments explaining what the test
  protects and how it broke before

State that is not code: `config.json` (never written at runtime),
`data/runtime.json` (the three settings EVE changes about herself),
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
7. **`.gitignore` paths stay root-anchored** (`/memory/`, not `memory/`) — a
   bare `memory/` once swallowed `src/memory/` and shipped three commits
   without their own code.
8. **`AGENT.md` is Umberto's document.** Refine it when he asks; never
   restructure, rewrite, or overwrite it on your own initiative. It is the
   source of truth the rest of the repo is checked against.

## Conventions

- **Check `src/tools/` before adding a tool.** One file per tool, registered
  through `src/core/registry.ts`. Extend an existing one rather than minting a
  near-duplicate beside it.
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
