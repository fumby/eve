# EVE — architecture

A tour of how one turn actually runs, and of the five or six decisions that shape
everything else. Written for someone reading the code, not for someone deciding
whether to.

Everything below is in this repository unless marked *(not published)*. See the
README for what was withheld and why.

---

## 1. The spine: one turn

```
mic / keyboard / heartbeat
        │
        ▼
   Agent.runTurn()                        src/core/agent.ts
        │
        ├── buildStableBlock()            src/brain/prompt.ts   ← cached prefix
        ├── contextBlock()                                      ← rides the user msg
        │
        ▼
   streamTurn()                           src/core/provider.ts  ← the only SDK import
        │
        ├── text deltas ──────────────────► caller's callback (terminal / WebSocket)
        │
        └── tool_use ──► Registry.execute()  src/core/registry.ts
                              │
                              ├── zod parse
                              ├── THE GATE  ← consequential? ask, or auto-deny
                              ├── tool.run()
                              └── audit()
                              │
                              ▼
                     results go back as ONE user message, loop again (≤ 12 rounds)
        │
        ▼
   recordExchange()                       src/core/conversations.ts
   trimExchanges()                        ← whole exchanges only
```

Three things are deliberate here.

**There is one loop.** Typed turns, spoken turns, face turns and the heartbeat's own
unprompted turns all enter through `runTurn`. A second code path for voice is the
obvious shortcut and the reason voice assistants drift out of sync with their text
selves; the comment at the top of the file says *never fork this*, and nothing does.

**The window is trimmed at exchange boundaries only.** `trimExchanges` drops whole
user/assistant pairs and rewrites the index array in place. Cutting anywhere else
orphans a `tool_use` from its `tool_result`, and the API rejects that conversation
outright. It is a standalone function rather than a method so the tests can hammer it
with synthetic histories.

**A failed turn rewinds.** On any exception the history is truncated back to the
index it had before the turn started, so the next attempt begins clean instead of
replaying half an exchange.

---

## 2. Prompt assembly, and why the layout is load-bearing

`buildStableBlock()` concatenates, in fixed order: identity → code-owned rails →
core knowledge → derived capabilities → queryable-data notes → memory index. It is
marked `cache_control: ephemeral` by the caller, so on repeat turns it re-bills at
about a tenth of the input price and re-bills in full only when one of the underlying
files actually changes — which is exactly when it should.

Two consequences that are easy to get wrong:

- **Order is frozen.** A reordered prompt is a cache miss for no reason, so
  `CORE_FILES` and `DATA_DOCS` are fixed arrays, not directory listings.
- **Per-turn facts do not go in a system block.** The clock reading, session age,
  channel and previous-session end are assembled by `contextBlock()` and appended to
  the *newest user message*. The stable block carries one cache breakpoint and the
  newest message carries another; a mutating system block would sit between them and
  silently re-bill the whole conversation every turn.

`contextBlock()` contains no behavioural instruction, on purpose — nothing in it says
how to treat the user in light of those facts. That split makes it possible to measure
whether the facts alone change behaviour before a single rule is written. The one
imperative that survives is functional rather than behavioural: it says how to do
arithmetic on dates. The elapsed span is computed in code because the model reads both
clock readings correctly and then fuzzes the subtraction between them.

Past a configured depth (12 exchanges) a short, static self-audit block is appended as
a second, uncached system block — the point in a long conversation where models start
imitating their own recent replies instead of their instructions.

Personality lives in `brain/identity.md` *(not published)* as plain prose, re-read on
every turn: editing it changes the next reply with no restart. The safety rails live
in `prompt.ts` as a code constant, so no personality edit can switch them off. That
split is the whole design.

---

## 3. The registry and the gate

A capability is one self-contained file in `src/tools/` registered through
`src/core/registry.ts`. The agent loop never learns a tool's name. Each tool declares
a `zod` schema (rendered to JSON Schema for the API), a description written for a
reader, and whether it is consequential.

`needsConfirmation` may be a boolean **or a function of the parsed arguments**, for
tools that are ordinary almost always and consequential in one specific shape —
`save_memory` is gated only when what is about to be written looks like a credential.

Inside `execute()`:

1. Parse with `zod`; a schema failure returns a readable message to the model, not an
   exception.
2. If consequential, render the call **twice**: `human` (what I read, and may quote
   the content I am judging) and `log` (what reaches `logs/audit.jsonl` and the
   notices inbox, and must never carry a secret). A tool asking me to confirm saving
   something sensitive must not write that thing to the log while asking.
3. If there is no human on this channel — a heartbeat turn, a background job — the
   gate **auto-denies, audits, and drops a note in the inbox**. Blocking forever and
   acting unapproved are both worse failures than doing nothing and saying so.
4. Approval never generalises. One yes covers one call.

`config.confirmOverrides` can flip a tool's flag without touching code.

The Factory (§6) needs a second, orthogonal answer: may a *spawned* agent be handed
this tool? `isFactoryAllowed()` is a pure function — an explicit `factoryAllowed` flag
wins, otherwise anything unconditionally gated, or matching the withheld prefixes
(`set_`, `forget_`, `design_`, `convene_board`, `query_ledger`, `dispatch_to_`), is
refused. Note the `=== true`: a *conditionally* gated tool stays available, because the
gate still fires per call, and on a registry with no human attached that means
auto-deny, never a silent run.

---

## 4. Memory, in four layers

| Layer | Where | Written by |
|---|---|---|
| Identity | `brain/identity.md` *(not published)* | me only |
| Core knowledge | `memory/core/*.md` *(not published)* | me only |
| Working memory | `data/conversations.json` | the agent loop |
| Long-term memory | `memory/store/*.md` | EVE, two ways |

Every layer is markdown or JSON on disk, human-readable and hand-editable. The files
*are* the memory; every index or vector built over them is derived and disposable.

**Working memory** persists as it happens. Restarting within a 45-minute window
resumes the same conversation with its real turns re-seeded as clean user/assistant
pairs — no tool blocks, which would be invalid out of context. The live window is
bounded at 30 exchanges; the resumed agent keeps the *original* start time so session
age and exchange count describe the same span.

**Long-term memory** is one markdown file per memory: a type, a one-line hook, a
creation date, and a body saying why the fact matters and how to apply it. Recall is
semantic (Voyage embeddings) with a keyword fallback — it degrades, never breaks, and
the vector index rebuilds from the files. Memories are written two ways: deliberately
mid-conversation via `save_memory`, and by a cheap extractor pass (Haiku) that runs
when a session ends, with dedupe against what is already stored.

### The credential filter

`isSensitive()` in `src/memory/store.ts` is two regexes:

- **Case-insensitive** for keywords — `PASSWORD` and `password` are equally a password.
- **Case-sensitive** for structured shapes — an AWS key id, a JWT, an Italian IBAN and
  a codice fiscale are *defined* by their case, and folding it turns the
  codice-fiscale shape (six letters, two digits, …) into something ordinary prose can
  stumble into.

Neither carries `/g`: `.test()` on a global regex is stateful and would alternate
true/false across calls, letting every second secret through. `token` and `secret` are
deliberately narrow — bare, they refuse ordinary speech ("~13k tokens cached per turn"
is worth remembering), so they only count with a credential-ish affix or an assignment.

Two placement decisions:

- The filter sits at **the one function that writes a file**, not in the extractor.
  The extractor is only one of the ways in; `save_memory` and anything the Factory
  spawns are the others, and a filter guarding one door is a filter with a hole in it.
- The refusal is **thrown, not returned**. A boolean has to be checked by every
  caller, and the caller who forgets *is* the hole. The message names the category and
  never the match, because `registry.execute()` writes `err.message` into the audit
  log.

There is exactly one documented way past it — `confirmedByHuman`, legitimate only
because the confirmation gate has already asked. It is a separate argument
specifically so no model-authored tool-call JSON can reach it, and
`tests/memory-boundaries.test.ts` asserts that it has exactly one call site and is
computed from the *same* predicate the gate opens on. A hardcoded `true` there would
claim I approved something I was never asked about.

### The boundary that is an absence

`memory/core/` and `brain/identity.md` are mine. EVE has no tool and no code path
that writes there. That is not a permission bit or a marker in the text — it is the
absence of a writer, and an absence is easy to break by accident.

`tests/memory-boundaries.test.ts` reads every source file under `src/`, `scripts/`
and `tests/` and fails if a filesystem write ever appears near one of those paths, in
any of the textual forms they take: the literal path, the named constants that hold
it, and the split `path.join(ROOT, "memory", "core")` form, which never contains the
substring `memory/core`. The test also asserts that the scan found files at all —
without that, a scanner that silently read nothing would let every assertion below it
pass while checking nothing. Both blind spots are historical: the original scanner
skipped `scripts/`, and a real violation was living there while the test stayed green.

---

## 5. The board

Four advisors — Drucker, Munger, Newport, Hormozi — each a markdown dossier of
numbered, sourced doctrine entries (`board/*.md`, published).

Each seat is **one isolated model call containing only that seat's dossier**. No seat
knows the others exist, so agreement between them means something. A seat may cite
only doctrine ids it was shown; anything else is stripped server-side, and a seat
abstains when the question falls outside its doctrine. EVE chairs: she alone sees the
full live situation, names the split before the agreement, and discounts seats through
their documented blind spots.

Meetings cost real money and are capped in config (measured ~$0.08–0.16). Every
meeting is stored with a snapshot of the citations it used. Editing an entry's
substance automatically drops its verification from `sourced` to `user` via
server-owned hashes; retiring an entry keeps its id reserved, so stored citations
never silently re-point at different text.

---

## 6. The Factory: sub-agents as configuration

`src/factory/` is a sub-agent whose only job is to mint other sub-agents.

```
"build me an agent that …"
   └─ research  → real web sources → structured Skills Report (cached 24h)
   └─ generate  → human-readable spec + system prompt + tool allowlist from the catalog
   └─ approve   → a manifest I approve or reject with feedback   ← nothing ships unapproved
   └─ store     → a row in data/factory/agents.json
   └─ watcher   → registers dispatch_to_<slug> within a tick, no restart
```

An approved agent is **pure configuration**: prompt, model, tool allowlist. One
generic runtime (`runtime.ts`) turns a row into a tool-use loop. There are no
per-agent classes and no per-slug branches anywhere in it — if two agents behave
differently it is because their rows differ, never because the code knows their names.

The runtime does not trust the row it is running, because `agents.json` is
hand-editable and a tool's policy can change after an agent was spawned:

- The tool allowlist is intersected with `isFactoryAllowed()` **at run time**, and
  resolved once per run so a watcher tick cannot change what an agent can see halfway
  through its own work.
- The code-owned rails paragraph is re-appended if a row does not already end with it.
- Name and specialty are collapsed to one capped line, because they come from user
  text and web-shaped research and get copied into EVE's own system prompt every turn.
- Spawned agents cannot dispatch to each other; tools that spend, delete, change
  settings, read the ledger or dispatch design are never handed out.
- Three rejections kill a task; at most five agents are staged per day.

---

## 7. The head of design

`src/design/` commissions mockups by driving Claude Code through the Claude Agent SDK.

A **planner** turns the request plus three project documents into one validated plan —
slugs, a specific visual direction, catalog components, image briefs, and the brief's
standing decisions and forbidden moves lifted verbatim. The brief is law: a request
that conflicts with it comes back as a stop plus open questions, never a silent
override.

A **composer** runs the child agent with `settingSources: []`, an explicit env
allowlist (five variables — nothing else reaches the child), a narrow `allowedTools`
list, a hard `maxBudgetUsd`, and a process-tree sweep on abort. Every run's full
options object is logged with secrets redacted.

An **audit** pass then reads the generated page and checks it against the design
system mechanically — ambient texture opacity, a named product surface, continuous
motions, hover states, mono marginalia, every generated image referenced verbatim, no
forbidden fonts, every imported component actually rendered. A failure buys one repair
round with the list of misses.

---

## 8. The heartbeat

EVE acting without being spoken to. A light loop wakes on an interval, runs
config-defined checks when due, and routes anything noteworthy into a dismissible
inbox. Quiet by default: most ticks produce nothing, quiet hours hold banners, and
only the genuinely urgent interrupts. `/pause` halts every proactive behaviour at once
and is audited as a kill switch. The timer is `unref`'d — the heartbeat never keeps
the process alive on its own.

The repo watch is a heartbeat check with **zero model calls**: pure GitHub API polling
that pings only for CI failures on protected branches, pushes to `hotfix/*` or
`rollback/*`, PRs stale 48h+, HIGH/CRITICAL Dependabot alerts, and repos that go
silent after real sustained activity. Never for green runs or routine pushes. Each
event pings exactly once; the state that makes that true lives in a JSON file.

---

## 9. State, and the absence of a database

EVE's own state is plain files. `config.json` is read-only at runtime; the two
settings she changes about herself live in `data/runtime.json`. All JSON state is
written atomically — temp file, then rename — through one helper, never a bare
`writeFileSync`. Everything mutable resolves against `STATE_ROOT`, not the repo root,
which is what lets the whole system run against a throwaway directory.

The one database in the picture is a Supabase Postgres holding my own transactions,
and EVE is a strictly read-only **client** of it. Two independent walls: a DB role
that is SELECT-only with a statement timeout, and a pure guard
(`src/tools/ledger-sql.ts`) that tokenizes the SQL, strips comments and literals, and
allows only `SELECT`/`WITH` — no semicolons, no DDL or DML keywords, no locks or
side-effect functions, with row and character caps. The guard is a separate module
with no I/O so it can be tested exhaustively without a database, the same split
`src/projects/` uses.

The audit trail is `logs/audit.jsonl`, one JSON line per event, and it doubles as the
cost ledger: cache reads are billed at 10% and cache writes at 125%, counted honestly
so the caching design's savings are *measured* rather than asserted. The mind-map
visualiser subscribes to the audit stream rather than the other way round, so nothing
in the hot path knows a visualiser exists, and a spectator that throws can never break
the thing it is watching.

---

## 10. How this codebase is tested

308 tests over 28 files, plus a separate `scripts/` directory of real-model,
real-filesystem checks that are typechecked on purpose — a broken reference there used
to compile clean and only fail once someone had paid to run it.

The rules that produce the tests you'll actually find interesting:

- **Never ship a guard you have not watched go red.** Introduce a real violation, see
  the test fail, then remove it. A guard that has only ever been green is not known to
  work.
- **The suite refuses to run un-isolated.** It once wrote over real conversations,
  real memories and the real audit log — silently, and green the whole time.
- **Tests carry prose.** Each one says what it protects and how it broke before. That
  is why several of them read like incident reports: they are.

Three of the 308 read the operator's own notes, which are not in this mirror;
`.example` templates stand in for them. Two more encode assumptions about the host
they were written on (a non-root user, a home directory more than one level below
`/`) and fail on a bare container.

---

## Known limits

- **One user.** Per-user state was considered and deliberately not built.
- **Access control on the face server is the weak point.** It binds loopback and is
  reached from other devices over Tailscale Serve; the WebSocket upgrade check
  compares hostnames rather than validating `Host` against a fixed allowlist. Found by
  an adversarial audit of this codebase, and being worked through. The audit itself is
  not published.
- **No wake word**, by design. Voice is tap-to-talk.
- **A sleeping Mac pauses the heartbeat.** It catches up on wake. A cloud migration was
  planned and then suspended: EVE's state stays in files by decision, not inertia.
