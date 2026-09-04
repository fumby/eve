// EVE's front door. Two ways in, ONE brain:
//   npm run eve    → typed REPL (the forever-alive debug path)
//   npm run voice  → tap-to-toggle voice wrapped around the same agent
import readline from "node:readline";
import { loadEnv, loadConfig, setHeartbeatPaused } from "./core/config.js";
import { latestResumable, conversationTitle, getConversation } from "./core/conversations.js";
import { extractConversation, catchUpExtractions } from "./memory/extractor.js";
import { Agent } from "./core/agent.js";
import { ProviderError } from "./core/provider.js";
import { Registry } from "./core/registry.js";
import { reminderTools } from "./tools/reminders.js";
import { noteTools } from "./tools/notes.js";
import { projectTools } from "./tools/projects.js";
import { memoryTools } from "./tools/memory.js";
import { weatherTools } from "./tools/weather.js";
import { researchTools } from "./tools/research.js";
import { perplexityTools } from "./tools/perplexity.js";
import { factoryTools } from "./tools/factory.js";
import { installWatcher } from "./factory/watcher.js";
import { pendingApproval, getTask, activeAgents, archiveAgent } from "./factory/store.js";
import { approveTask, rejectTask, NotApprovable } from "./factory/approve.js";
import { boardTools } from "./tools/board.js";
import { ledgerTools } from "./tools/ledger.js";
import { designTools } from "./design/tools.js";
import { Heartbeat } from "./heartbeat.js";
import { listNotices, dismissNotice, dismissAll, type Notice } from "./core/notices.js";
import { audit, usageToday } from "./core/audit.js";

loadEnv();

// One watcher PER registry (interactive + heartbeat); /factory commands poke
// all of them. (A single variable here once pointed only at the heartbeat's
// watcher, so approvals never reached the registry EVE actually talks with.)
const watchers: ReturnType<typeof installWatcher>[] = [];
const refreshWatchers = () => watchers.forEach((w) => w.refresh());

function buildRegistry(): Registry {
  const r = new Registry();
  for (const t of [...reminderTools, ...noteTools, ...projectTools, ...memoryTools, ...weatherTools, ...researchTools, ...perplexityTools, ...boardTools, ...ledgerTools, ...designTools]) r.register(t);
  // The Factory: its own tools, plus every approved spawned agent as
  // dispatch_to_<slug> — loaded now and refreshed live by the watcher.
  for (const t of factoryTools(r)) r.register(t);
  watchers.push(installWatcher(r));
  return r;
}
// Approvals from the face land in the shared file; the REPL notices within 30s.
setInterval(refreshWatchers, 30_000).unref();

// The interactive registry's gate asks Umberto. The heartbeat gets its own
// registry with NO confirm hook, so background actions auto-deny + leave a
// note instead of blocking forever on a human who isn't there.
const registry = buildRegistry();
const heartbeatRegistry = buildRegistry();

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const magenta = (s: string) => `\x1b[35m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

function printError(err: unknown): void {
  const msg =
    err instanceof Error ? err.message : `Something unexpected broke: ${String(err)}`;
  process.stdout.write(`${yellow("(hiccup)")} ${msg}\n\n`);
}

// Catch-up-on-return: anything EVE noticed while the app was closed is shown
// here — held, never lost.
function printCatchUp(): void {
  const open = listNotices();
  if (open.length === 0) return;
  console.log(`🔔 While you were away, EVE noticed ${open.length} thing${open.length > 1 ? "s" : ""}:`);
  for (const n of open) console.log(`   [${n.id}] ${n.text}`);
  console.log(dim("   dismiss with /dismiss <id> or /dismiss all\n"));
}

// Returns true if the line was a command (already handled).
async function handleCommand(text: string): Promise<boolean> {
  if (text === "/notices") {
    const open = listNotices();
    if (open.length === 0) console.log(dim("Inbox empty — EVE has nothing pending for you.\n"));
    else for (const n of open) console.log(`   [${n.id}] ${n.text}`);
    return true;
  }
  if (text === "/dismiss all") {
    console.log(dim(`Cleared ${dismissAll()} notice(s).\n`));
    return true;
  }
  if (text.startsWith("/dismiss ")) {
    const id = text.slice("/dismiss ".length).trim();
    console.log(dim(dismissNotice(id) ? `Dismissed ${id}.\n` : `No open notice ${id}.\n`));
    return true;
  }
  if (text === "/pause") {
    setHeartbeatPaused(true);
    console.log(yellow("⏸  All proactive behavior paused. Conversation still works. /resume to wake it.\n"));
    return true;
  }
  if (text === "/resume") {
    setHeartbeatPaused(false);
    console.log(dim("▶️  Heartbeat resumed.\n"));
    return true;
  }
  if (text === "/usage") {
    const u = await usageToday();
    console.log(
      dim(
        `Today: ${u.turns} model turns, ${u.inputTokens} tokens in / ${u.outputTokens} out` +
          ` (cache: ${u.cacheReadTokens} read, ${u.cacheWriteTokens} written) ≈ $${u.cost.toFixed(4)}\n`,
      ),
    );
    return true;
  }
  if (text === "/factory" || text === "/factory pending") {
    const pending = pendingApproval();
    const agents = activeAgents();
    if (agents.length) console.log(dim(`Active: ${agents.map((a) => `${a.name} [${a.slug}]`).join(", ")}`));
    if (pending.length === 0) console.log(dim("Nothing awaiting approval.\n"));
    for (const t of pending) {
      const m = t.proposedManifest!;
      console.log(`\n${cyan(`[${t.id}] ${m.name}`)} — ${m.specialty}  (round ${t.approvalIterations + 1})`);
      console.log(dim(`  slug: ${m.slug}   model: ${m.model}   tools: ${m.tool_allowlist.join(", ") || "none"}`));
      console.log(dim(`  spec: agent-specs/${m.slug}.md`));
      console.log(`  ${m.system_prompt.split("\n").join("\n  ")}\n`);
    }
    console.log(dim("/factory approve <id>   /factory reject <id> [feedback]   /factory archive <slug>\n"));
    return true;
  }
  if (text.startsWith("/factory approve ")) {
    const id = text.slice("/factory approve ".length).trim();
    try {
      const a = approveTask(id, { onAgentAdded: refreshWatchers });
      console.log(dim(`✓ ${a.name} is live as dispatch_to_${a.slug}.\n`));
    } catch (err) {
      console.log(yellow(err instanceof NotApprovable ? err.message : `approve failed: ${String(err)}`) + "\n");
    }
    return true;
  }
  if (text.startsWith("/factory reject ")) {
    const rest = text.slice("/factory reject ".length).trim();
    const [id, ...fb] = rest.split(/\s+/);
    const feedback = fb.join(" ").trim() || null;
    try {
      console.log(dim(feedback ? "(revising the prompt with your feedback…)" : "(rejected)"));
      const t = await rejectTask(id!, feedback, registry);
      console.log(dim(`→ ${t.nameHint}: ${t.status}${t.error ? ` (${t.error})` : ""}\n`));
    } catch (err) {
      console.log(yellow(err instanceof NotApprovable ? err.message : `reject failed: ${String(err)}`) + "\n");
    }
    return true;
  }
  if (text.startsWith("/factory archive ")) {
    const slug = text.slice("/factory archive ".length).trim();
    const a = archiveAgent(slug);
    refreshWatchers();
    console.log(dim(a ? `Archived ${a.name}; dispatch_to_${slug} withdrawn.\n` : `No active agent "${slug}".\n`));
    return true;
  }
  if (text.startsWith("/factory show ")) {
    const t = getTask(text.slice("/factory show ".length).trim());
    console.log(t ? JSON.stringify(t, null, 2) + "\n" : yellow("no such task\n"));
    return true;
  }
  if (text === "/help") {
    console.log(dim("/notices  /dismiss <id>  /dismiss all  /pause  /resume  /usage  /factory  /quit\n"));
    return true;
  }
  return false;
}

function startHeartbeat(promptAfterBanner: string): Heartbeat {
  const hb = new Heartbeat(heartbeatRegistry, (n: Notice) => {
    process.stdout.write(
      `\n🔔 ${magenta("EVE")} ${n.text}\n   ${dim(`(dismiss with /dismiss ${n.id})`)}\n${promptAfterBanner}`,
    );
  });
  hb.start();
  return hb;
}

// One consumer for stdin lines, shared by the main loop and the gate's
// confirmation questions. take(timeout) resolves undefined on timeout and
// leaves the eventual line for the next caller.
class LineQueue {
  private lines: string[] = [];
  private waiters: ((line: string | null) => void)[] = [];
  private closed = false;

  constructor(rl: readline.Interface) {
    rl.on("line", (l) => {
      const w = this.waiters.shift();
      if (w) w(l);
      else this.lines.push(l);
    });
    rl.on("close", () => {
      this.closed = true;
      for (const w of this.waiters.splice(0)) w(null);
    });
  }

  take(timeoutMs?: number): Promise<string | null | undefined> {
    const queued = this.lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      const waiter = (l: string | null) => {
        if (timer) clearTimeout(timer);
        resolve(l);
      };
      const timer = timeoutMs
        ? setTimeout(() => {
            const i = this.waiters.indexOf(waiter);
            if (i >= 0) this.waiters.splice(i, 1);
            resolve(undefined);
          }, timeoutMs)
        : null;
      this.waiters.push(waiter);
    });
  }
}

// ---------------------------------------------------------------- typed mode
async function runText(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const q = new LineQueue(rl);
  const PROMPT = cyan("you › ");

  registry.confirm = async (_tool, intent) => {
    process.stdout.write(
      `\n${yellow("⚠ EVE wants to run:")} ${intent}\n${yellow("Allow this once? [y/N] (auto-No in 60s) ›")} `,
    );
    const ans = await q.take(60_000);
    if (ans === undefined) {
      process.stdout.write(dim("…no answer, so: No.\n"));
      return false;
    }
    return ans !== null && /^(y|yes|si|sì)$/i.test(ans.trim());
  };

  const resume = latestResumable(loadConfig().memory.resumeWindowMinutes) ?? undefined;
  const agent = new Agent(registry, "typed", resume);

  console.log("EVE is awake. Type to talk; /help for commands; /quit to leave her be.\n");
  if (resume) console.log(dim(`(picking back up: "${conversationTitle(resume)}")\n`));
  void catchUpExtractions(); // settle memory debt from sessions that ended unclean
  printCatchUp();
  startHeartbeat(PROMPT);
  process.stdout.write(PROMPT);

  while (true) {
    const line = await q.take();
    if (line === null || line === undefined) break;
    const text = line.trim();
    if (text === "/quit" || text === "/exit") break;
    if (await handleCommand(text)) {
      process.stdout.write(PROMPT);
      continue;
    }
    if (text.length > 0) {
      process.stdout.write(magenta("EVE › "));
      try {
        await agent.runTurn(text, {
          onText: (d) => process.stdout.write(d),
          onToolCall: (name) => process.stdout.write(dim(`[using ${name}…] `)),
        });
        process.stdout.write("\n\n");
      } catch (err) {
        printError(err);
      }
    }
    process.stdout.write(PROMPT);
  }
  // Before leaving, the extractor keeps anything from this conversation worth
  // remembering — otherwise it dies with the process.
  process.stdout.write(dim("\n(saving what's worth remembering…)\n"));
  const r = await extractConversation(getConversation(agent.conversationId));
  if (r.saved.length > 0)
    process.stdout.write(dim(`(kept: ${r.saved.map((m) => m.hook).join(" · ")})\n`));
  console.log("EVE: Ciao! 👋");
  rl.close();
}

// ---------------------------------------------------------------- voice mode
async function runVoice(): Promise<void> {
  const { Recorder } = await import("./voice/capture.js");
  const { transcribeBest, pcmToWav, LiveTranscriber } = await import("./voice/stt.js");
  const { Speaker, warmTts } = await import("./voice/tts.js");

  console.log(
    "EVE voice mode 🎙\n" +
      "  SPACE  start talking / send what you said\n" +
      "  SPACE  (while she speaks) cut her off\n" +
      "  q      quit\n" +
      "Transcripts stay visible so you can check what she heard.\n",
  );
  printCatchUp();
  startHeartbeat("");

  let state: "idle" | "recording" | "busy" = "idle";
  let recorder: InstanceType<typeof Recorder> | null = null;
  let live: InstanceType<typeof LiveTranscriber> | null = null;
  let speaker: InstanceType<typeof Speaker> | null = null;
  let pendingConfirm: ((ok: boolean) => void) | null = null;

  registry.confirm = async (_tool, intent) => {
    process.stdout.write(
      `\n${yellow("⚠ EVE wants to run:")} ${intent}\n${yellow("Press y to allow this once — any other key refuses (auto-No in 30s)")}\n`,
    );
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        pendingConfirm = null;
        resolve(false);
      }, 30_000);
      pendingConfirm = (ok) => {
        clearTimeout(timer);
        pendingConfirm = null;
        resolve(ok);
      };
    });
  };

  const resume = latestResumable(loadConfig().memory.resumeWindowMinutes) ?? undefined;
  if (resume) console.log(`(picking back up: "${conversationTitle(resume)}")\n`);
  const agent = new Agent(registry, "voice", resume);
  const status = (s: string) => process.stdout.write(`\r\x1b[2K${s}`);

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  const quit = async (): Promise<never> => {
    speaker?.stop();
    live?.abort();
    if (recorder) await recorder.stop().catch(() => new Int16Array(0));
    // Voice sessions used to exit without keeping anything — the main leak.
    status("(saving what's worth remembering…)");
    await extractConversation(getConversation(agent.conversationId));
    console.log("\nEVE: Ciao! 👋");
    process.exit(0);
  };

  const finishTurn = async (): Promise<void> => {
    if (!recorder) return;
    const rec = recorder;
    const lt = live;
    recorder = null;
    live = null;
    state = "busy";
    // t=0 is the moment you tap "send" — every mark below is relative to it.
    const tap = Date.now();
    const marks = { transcript: 0, firstToken: 0, firstAudio: 0 };
    status(dim("✏️  transcribing…"));
    try {
      const pcm = await rec.stop();
      if (pcm.length < 8000) {
        lt?.abort();
        status("");
        process.stdout.write(dim("(too short — tap space and speak)\n"));
        state = "idle";
        return;
      }
      // The live socket gave instant captions; Scribe is the recogniser of
      // record and gets the complete audio.
      const liveText = lt ? await lt.finish() : null;
      const result = await transcribeBest(pcmToWav(pcm, rec.sampleRate), liveText);
      const heard = result.text;
      const usedFallback = result.source === "deepgram";
      marks.transcript = Date.now();
      status("");
      if (!heard) {
        process.stdout.write(dim("(heard nothing intelligible — try again)\n"));
        state = "idle";
        return;
      }
      const langTag = result.language ? dim(` [${result.language}]`) : "";
      process.stdout.write(`${cyan("you (heard) ›")}${langTag} ${heard}\n`);
      process.stdout.write(magenta("EVE › "));
      speaker = new Speaker({
        onError: (msg) => process.stdout.write(dim(`[voice hiccup: ${msg}] `)),
        onFirstPlay: () => {
          if (!marks.firstAudio) marks.firstAudio = Date.now();
        },
      });
      const s = speaker;
      await agent.runTurn(
        heard,
        {
          onText: (d) => {
            if (!marks.firstToken) marks.firstToken = Date.now();
            process.stdout.write(d);
            s.feed(d);
          },
          onToolCall: (name) => process.stdout.write(dim(`[using ${name}…] `)),
        },
        { language: result.language, speakers: result.speakers },
      );
      process.stdout.write("\n");
      await s.end();
      speaker = null;
      const rel = (t: number) => (t ? `${((t - tap) / 1000).toFixed(2)}s` : "—");
      process.stdout.write(
        dim(
          `⏱  transcript ${rel(marks.transcript)}${usedFallback ? " (fallback)" : ""} · ` +
            `first token ${rel(marks.firstToken)} · first audio ${rel(marks.firstAudio)}\n`,
        ),
      );
      audit("voice_latency", {
        transcriptMs: marks.transcript ? marks.transcript - tap : null,
        firstTokenMs: marks.firstToken ? marks.firstToken - tap : null,
        firstAudioMs: marks.firstAudio ? marks.firstAudio - tap : null,
        sttFallback: usedFallback,
      });
      process.stdout.write(dim(s.interrupted ? "(cut off — tap space to talk)\n\n" : "(tap space to talk)\n\n"));
    } catch (err) {
      lt?.abort();
      status("");
      printError(err);
    }
    state = "idle";
  };

  process.stdin.on("keypress", (_str: string, key: { name?: string; ctrl?: boolean }) => {
    if (key.ctrl && key.name === "c") void quit();
    if (pendingConfirm) {
      pendingConfirm(key.name === "y"); // only an explicit y approves
      return;
    }
    if (key.name === "q") void quit();
    if (key.name !== "space") return;

    if (state === "idle") {
      try {
        recorder = new Recorder();
        // Stream frames to Deepgram AS you speak; show what she's hearing.
        live = new LiveTranscriber((text) =>
          status(`🎙  ${cyan("hearing:")} ${text.length > 70 ? "…" + text.slice(-70) : text}`),
        );
        const lt = live;
        recorder.start((frame) => lt.sendPcm(frame));
        warmTts(); // TLS handshake now, not when the first sentence needs it
        state = "recording";
        status(`🎙  ${cyan("listening…")} ${dim("tap space to send")}`);
      } catch (err) {
        printError(err);
        live?.abort();
        recorder = null;
        live = null;
      }
    } else if (state === "recording") {
      void finishTurn();
    } else if (state === "busy" && speaker) {
      speaker.stop(); // barge-in: silence her; text finishes printing quietly
    }
  });

  process.stdout.write(dim("(tap space to talk)\n"));
}

if (process.argv.includes("--voice")) void runVoice();
else void runText();
