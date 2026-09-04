// The label layer: plain HTML, one label per agent (name on top, specialty
// beneath), moved every frame to sit just below its avatar's spot on screen.
// Two touches make them feel three-dimensional: they fade when the agent is
// on the far side of its orbit (hidden entirely when directly behind the
// orb) and stack by depth so a near name sits over a far one. A label is
// revealed only once its first real position is known — never a flash in the
// top-left corner on load.

import * as THREE from "three";

export function createLabels({ root }) {
  const items = new Map(); // id → { el, name, spec }
  const v = new THREE.Vector3();

  function ensure(agent) {
    let it = items.get(agent.id);
    if (it) return it;
    const el = document.createElement("div");
    el.className = "agent-label";
    el.dataset.agent = agent.id;
    const name = document.createElement("b");
    name.textContent = agent.name;
    const spec = document.createElement("span");
    spec.textContent = agent.specialty || "";
    el.append(name, spec);
    el.style.setProperty("--agent", agent.color || "#2DD4A8");
    root.appendChild(el);
    it = { el, name, spec, agent, placed: false };
    items.set(agent.id, it);
    return it;
  }

  return {
    ensure,
    remove(id) {
      const it = items.get(id);
      if (!it) return;
      it.el.remove();
      items.delete(id);
    },
    setStatus(id, text) {
      const it = items.get(id);
      if (it) it.el.title = text || "";
    },
    /**
     * agents: iterable of {id, name, specialty, color, world:[x,y,z], radiusPx?, hidden?}
     * camera: the orb layer camera. viewport: {width,height}. orbScreen: {x,y,r} px.
     */
    update(agents, camera, viewport, orbScreen, visible = true) {
      root.style.display = visible ? "" : "none";
      if (!visible) return;
      const W = viewport.width, H = viewport.height;
      for (const a of agents) {
        const it = ensure(a);
        if (a.hidden) {
          it.el.style.opacity = "0";
          continue;
        }
        v.set(a.world[0], a.world[1], a.world[2]).project(camera);
        const x = ((v.x + 1) / 2) * W;
        const y = ((1 - v.y) / 2) * H;
        // depth: v.z in NDC, smaller = nearer. Far side ≈ world z < 0.
        const far = a.world[2] < 0;
        const dx = x - orbScreen.x, dy = y - orbScreen.y;
        const behind = far && Math.hypot(dx, dy) < orbScreen.r * 0.95;
        const rPx = a.radiusPx ?? 18;
        it.el.style.transform = `translate(-50%, 0) translate3d(${x.toFixed(1)}px, ${(y + rPx + 6).toFixed(1)}px, 0)`;
        it.el.style.zIndex = String(100 + Math.round((1 - v.z) * 200));
        const target = behind ? 0 : far ? 0.45 : 1;
        it.el.style.opacity = String(target * (a.alpha ?? 1));
        it.el.classList.toggle("far", far);
        it.el.classList.toggle("working", !!a.working);
        if (!it.placed) {
          it.placed = true;
          it.el.classList.add("placed");
        }
      }
    },
    dispose() {
      for (const it of items.values()) it.el.remove();
      items.clear();
    },
  };
}
