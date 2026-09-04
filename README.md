# EVE

A voice-first personal assistant I built for myself and have been running every day
since August 2026. It listens, thinks, remembers, uses tools, spawns its own
specialist sub-agents, and occasionally speaks first when something deserves
attention.

It runs on my own machine, over my own tailnet. There is no product here and no
users but me — which is the point: every decision in this repo was made by someone
who has to live with it the next morning.

---

## What this repository is

This is a **public mirror** of a private working repository. The code is the real
code, copied from the working tree, not a rewrite for display. What is not here:

| Not published | Why |
|---|---|
| `memory/`, `data/`, `logs/` | EVE's actual memory and my personal notes. Git-ignored in the original too. |
| `brain/identity.md` | Her personality file — mine to write, and personal. A generic `brain/identity.example.md` is included. |
| `brain/ledger-schema.md` | Describes my own finances. A generic `brain/ledger-schema.example.md` is included. |
| `AGENT.md`, `docs/` | The internal spec, a security audit with open findings, and migration notes. |
| `design/.prism/brief.md` | Private positioning doc for the design agent. |
| `.env` | Keys. `.env.example` lists the names only. |

A handful of file paths and one voice ID were replaced with placeholders. Nothing
else was edited. `ARCHITECTURE.md` is the tour; this file is the summary.

---

## By the numbers

| | |
|---|---:|
| TypeScript in `src/` | 14,566 lines |
| Tests in `tests/` | 6,345 lines · 308 tests · 28 files |
| Browser code (`face/`, `mind/`) | 4,857 lines |
| Real-model check scripts (`scripts/`) | 1,763 lines |
| Tools registered | 29 |
| Runtime dependencies | 8 |

`tsc --noEmit` is clean. `npm test` runs 308 tests. Copy the `.example` files first
(see **Running it**): three tests read the operator's own notes, and those templates
stand in for them. Two further fixtures encode assumptions about the host they were
written on — a non-root user, and a home directory more than one level below `/` —
so they fail on a bare container and pass on an ordinary account.

## Stack

Node 22, TypeScript strict + `noUncheckedIndexedAccess`, ESM, no build step in
development (`tsx` runs the sources). Claude through the official Anthropic SDK
behind a one-file seam; the Claude Agent SDK for the design sub-agent; Deepgram for
speech-to-text; ElevenLabs for speech; Voyage for embeddings; `zod` for every tool
schema. Eight runtime dependencies total, on purpose.

---

## The five things worth reading

**1. One turn, one loop.** Typed input, spoken input, and EVE's own unprompted
heartbeat turns all enter through the same `Agent.runTurn`
([`src/core/agent.ts`](src/core/agent.ts)). There is no second code path for voice,
which is why voice and text can never drift apart in behaviour. The conversation
window is trimmed only at whole-exchange boundaries — a sliced `tool_use` /
`tool_result` pair is a conversation the API rejects outright.

**2. The gate is code, not a prompt.** Anything that sends, spends, deletes, or
changes a setting stops in `Registry.execute`
([`src/core/registry.ts`](src/core/registry.ts)) until I say yes, per action — one
yes covers exactly one call. Two details I'd defend in an interview: when no human
is on the channel (a background heartbeat turn) the gate **auto-denies and leaves a
note**, because "block and wait" and "act unapproved" are both worse; and each
gated call renders twice — one string for me to read, which may quote the content
I'm judging, and one for the audit log, which must never persist a secret.

**3. A boundary enforced by an absence, and a test that guards the absence.**
`memory/core/` and `brain/identity.md` are mine to write; EVE has no tool and no
code path that writes there. That protection is not a permission bit — it is the
*absence* of a writer, which is easy to break by accident.
[`tests/memory-boundaries.test.ts`](tests/memory-boundaries.test.ts) reads every
source file in `src/`, `scripts/` and `tests/` and fails if a filesystem write ever
appears next to one of those paths. The first version of that scanner never looked
at `scripts/`, and a real violation lived there while the test reported green.

**4. A credential filter placed at the write, not at the door.** Two regexes in
[`src/memory/store.ts`](src/memory/store.ts) — one case-insensitive for keywords,
one case-*sensitive* for structured shapes, because an AWS key id, a JWT, an Italian
IBAN and a codice fiscale are defined by their case, and folding it turns the
codice-fiscale shape into something ordinary prose stumbles into. Neither carries
`/g`, because `.test()` on a global regex is stateful and would let every second
secret through. It sits at the one function that writes a memory file rather than in
the extractor, because the extractor is only one of the ways in.

**5. Sub-agents that are configuration, not code.** The Factory
([`src/factory/`](src/factory/)) is a sub-agent whose only job is to mint other
sub-agents: it researches a domain, writes a human-readable spec, generates a system
prompt, picks tools from the catalog, and stages a manifest for me to approve.
Nothing goes live unapproved. Approved agents are rows in a JSON file that one
generic runtime ([`src/factory/runtime.ts`](src/factory/runtime.ts)) executes — no
class per agent, no branch on a slug anywhere. They appear as `dispatch_to_<slug>`
tools within a minute, without a restart.

Also in here, if you keep reading: an advisory **board** of four isolated model
calls that may only cite doctrine ids they were shown
([`src/board/`](src/board/)); a **head of design** that drives Claude Code through
the Agent SDK with an explicit env allowlist and a hard dollar cap
([`src/design/`](src/design/)); a **repo watch** that polls GitHub with zero model
calls and pings only for the five things that actually matter
([`src/watch/github.ts`](src/watch/github.ts)); a read-only **SQL guard** split into
a pure module so it can be tested without a database
([`src/tools/ledger-sql.ts`](src/tools/ledger-sql.ts)); and a **project reader**
that canonicalises every path through `fs.realpathSync.native`, because plain
`realpathSync` does not case-fold on macOS and every containment check was missing
by one character ([`src/projects/read.ts`](src/projects/read.ts)).

---

## The interface

`face/` is a live 3D interface, not a chat window: a wireframe orb that breathes,
listens, and deforms to the actual amplitude of her voice and mine, with her real
sub-agents orbiting it as a constellation and lighting up when they are actually
working. `mind/` is a 3D map of her memory, tools and knowledge, rendered live as
she thinks. Both are plain browser JavaScript over a WebSocket — no framework, no
build step. The pure maths (easing, orbits, docking, mood mapping, layout) is
separated out so it can be unit-tested without a canvas.

---

## Running it

```bash
nvm use                 # Node 22
npm install
cp .env.example .env    # then fill in the keys you actually want
cp brain/identity.example.md brain/identity.md
for f in memory/core/*.example.md; do cp "$f" "${f%.example.md}.md"; done

npm run eve             # typed REPL
npm run voice           # terminal voice mode — space to talk, space to send
npm run face            # the orb + the mind map at http://127.0.0.1:3939
npm test                # 308 tests
npm run typecheck       # tsc --noEmit
```

Only `ANTHROPIC_API_KEY` is required. Everything else degrades rather than breaks:
no Deepgram key means no voice, no Voyage key means memory recall falls back to
keyword search, no Gemini key means the design agent composes in TSX instead of
generating images.

The test suite refuses to run without an isolated state directory
([`tests/state-isolation.test.ts`](tests/state-isolation.test.ts)). It once wrote
over real conversations, real memories and the real audit log — silently, and green
the whole time.

---

## What I would tell you if you asked

- **The face server's access control is the weakest part.** It binds loopback and is
  reached from my other devices over Tailscale Serve; the WebSocket upgrade check
  compares hostnames rather than validating `Host` against a fixed allowlist. I know
  this because I had the codebase adversarially audited, and I am working through the
  findings. It is not published here, and neither are the findings.
- **It has exactly one user.** Per-user state was kept in mind and deliberately not
  built. Multi-user would touch the prompt cache strategy, the state paths and the
  face's one-writer rule.
- **A cloud migration was planned and then suspended.** EVE's own state is plain
  files by decision, not by inertia, and a generic "move it to Postgres" plan was
  rejected for that reason. The plan is kept privately for reference.
- **The comments are load-bearing.** They name the failure the code is preventing,
  usually one I actually caused. If a comment reads like an anecdote, it is one.

## Licence

No licence yet — published for reading, not for reuse. Ask me.
