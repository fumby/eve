import fs from "node:fs";

// Write to a sibling temp file, then rename over the target: a reader (or a
// crash, or a second writer) never sees a half-written file. Same-directory
// rename is atomic on macOS and Linux. Dependency-free so config.ts can use it
// without importing the store.
export function writeFileAtomic(target: string, contents: string): void {
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, contents);
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw err;
  }
}
