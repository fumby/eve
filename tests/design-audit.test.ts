// Tier 6: the TSX audit must reject the known failure modes (installed but
// unused, invisible texture, no product surface, nothing moving, 11px
// marginalia, dropped images) and accept a page that has all of it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { auditPageTsx, renderAuditForPrompt } from "../src/design/audit.js";

const GOOD = `"use client";
import { useEffect, useState } from "react";
import { GridPattern } from "@/components/ui/grid-pattern";
import { Particles } from "@/components/ui/particles";
import { BorderBeam } from "@/components/ui/border-beam";
import { NumberTicker } from "@/components/ui/number-ticker";
import { Button } from "@/components/ui/button";

function StatusReadout() {
  const [ms, setMs] = useState(287);
  useEffect(() => { const t = setInterval(() => setMs((m) => 250 + ((m * 7) % 90)), 900); return () => clearInterval(t); }, []);
  return <div className="font-mono uppercase tracking-widest text-sm text-muted-foreground hover:text-foreground">LISTENING · <NumberTicker value={ms} />ms</div>;
}
function ConversationSurface() {
  return <div className="rounded-lg border border-border bg-card p-4 hover:border-primary">
    <p className="font-mono uppercase tracking-wide text-[15px]">UMBERTO</p>
    <p className="animate-pulse">…</p>
  </div>;
}
export default function Page() {
  return <main className="relative min-h-dvh bg-background">
    <GridPattern className="opacity-50" />
    <Particles className="absolute inset-0 opacity-60" quantity={60} />
    <h1 className="font-display text-[128px] tracking-tight leading-[0.9]">EVE</h1>
    <span className="font-mono uppercase tracking-wide text-sm hover:underline">v0.9 · NAPLES</span>
    <StatusReadout />
    <ConversationSurface />
    <img src="/api/eve/preview/assets/landing/backdrop.png" alt="" />
    <div className="relative group hover:scale-[1.02]"><Button>Talk to EVE</Button><BorderBeam /></div>
  </main>;
}`;

test("a page with every required element passes", () => {
  const r = auditPageTsx(GOOD, { imageUrls: ["/api/eve/preview/assets/landing/backdrop.png"] });
  assert.equal(r.pass, true, renderAuditForPrompt(r));
  for (const c of r.checks) assert.equal(c.ok, true, `${c.name}: ${c.detail}`);
});

test("installed-but-unused, dim texture, no surface, no motion, 11px mono, dropped image all fail", () => {
  const bad = `import { GridPattern } from "@/components/ui/grid-pattern";
import { Marquee } from "@/components/ui/marquee";
export default function Page() {
  return <main>
    <GridPattern className="opacity-20" />
    <h1 className="text-[120px]">EVE</h1>
    <span className="font-mono uppercase text-xs">v0.9</span>
    <span className="font-mono uppercase text-[11px]">naples</span>
  </main>;
}`;
  const r = auditPageTsx(bad, { imageUrls: ["/api/eve/preview/assets/x/y.png"] });
  assert.equal(r.pass, false);
  const by = Object.fromEntries(r.checks.map((c) => [c.name, c]));
  assert.equal(by.background!.ok, false);
  assert.match(by.background!.detail, /opacity/);
  assert.equal(by["product-surface"]!.ok, false);
  assert.equal(by["continuous-motion"]!.ok, false);
  assert.equal(by["hover-states"]!.ok, false);
  assert.equal(by["mono-marginalia"]!.ok, false);
  assert.equal(by["images-referenced"]!.ok, false);
  assert.match(by["images-referenced"]!.detail, /y\.png/);
  assert.equal(by["imports-used"]!.ok, false);
  assert.match(by["imports-used"]!.detail, /Marquee/);
});

test("hooks without 'use client' and forbidden fonts are caught", () => {
  const r = auditPageTsx(`import { useState } from "react";
export default function Page(){ const [a] = useState(0); return <div style={{fontFamily:"Space Grotesk"}}>{a}</div>; }`);
  const by = Object.fromEntries(r.checks.map((c) => [c.name, c]));
  assert.equal(by["client-directive"]!.ok, false);
  assert.equal(by["no-forbidden-fonts"]!.ok, false);
  assert.match(by["no-forbidden-fonts"]!.detail, /Space Grotesk/);
});

test("server component without hooks passes the client-directive check; render is readable", () => {
  const r = auditPageTsx(`export default function Page(){ return <div/>; }`);
  const by = Object.fromEntries(r.checks.map((c) => [c.name, c]));
  assert.equal(by["client-directive"]!.ok, true);
  assert.match(renderAuditForPrompt(r), /✗ background/);
});
