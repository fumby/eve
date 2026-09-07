// Per-file test isolation. The suite runs files in parallel and each file
// imports src/core/config.js, which snapshots EVE_STATE_DIR at module load.
// Without this, two memory test files share one store directory and race:
// one file's saved memory leaks into another file's "the index is empty"
// assertion (seen live: "arci-300" reaching memory-sensitive.test.ts).
// Wired in globally by the `test` script in package.json, as a second
// `--import` after tsx: node:test runs each test FILE in its own child
// process, so one --import gives every file its own directory without any
// test having to remember to ask for it.
//
// It used to say "import this module FIRST in a test file". Nothing ever did —
// grep found zero importers — so the race it was written to prevent came
// straight back: `npm test` failed on 3 runs out of 8, in whichever file lost
// the race that time (watch, memory-sensitive, standing-checks). With this
// wired in it is 0 out of 8. An unused guard is not a guard.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.EVE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "eve-memtest-"));
