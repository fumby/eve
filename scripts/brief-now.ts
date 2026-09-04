// Run the daily briefing on demand: npm run brief
import { loadEnv } from "../src/core/config.js";
import { Heartbeat } from "../src/heartbeat.js";
import { Registry } from "../src/core/registry.js";
import { reminderTools } from "../src/tools/reminders.js";
import { noteTools } from "../src/tools/notes.js";
import { memoryTools } from "../src/tools/memory.js";
import { weatherTools } from "../src/tools/weather.js";
import { researchTools } from "../src/tools/research.js";
import { boardTools } from "../src/tools/board.js";
import { ledgerTools } from "../src/tools/ledger.js";

loadEnv();
const registry = new Registry();
for (const t of [...reminderTools, ...noteTools, ...memoryTools, ...weatherTools, ...researchTools, ...boardTools, ...ledgerTools]) registry.register(t);

const hb = new Heartbeat(registry);
hb.composeBriefing()
  .then((text) => console.log(`\n☀️  EVE's briefing:\n${text}`))
  .catch((err) => {
    console.error(`Briefing failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
