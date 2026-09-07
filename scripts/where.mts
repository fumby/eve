import { Cdp } from "../src/tools/cdp.js";
import http from "node:http";

// The CDP page list, as much of it as this probe needs. Typed rather than
// left as `any`: scripts/ is in tsconfig on purpose, and an untyped JSON.parse
// here compiled clean while the file itself did not.
interface CdpTarget {
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

const wsUrl = await new Promise<string>((resolve, reject) => {
  http.get("http://127.0.0.1:9222/json/list", (res) => {
    let d = "";
    res.on("data", (c) => (d += c));
    res.on("end", () => {
      const pages = (JSON.parse(d) as CdpTarget[]).filter(
        (t) => t.type === "page" && !t.url.startsWith("devtools") && !t.url.includes("omnibox"),
      );
      const last = pages[pages.length - 1];
      if (!last) return reject(new Error("no debuggable page open on 127.0.0.1:9222"));
      resolve(last.webSocketDebuggerUrl);
    });
  }).on("error", reject);
});
const cdp = new Cdp();
await cdp.connect(wsUrl);
const info = await cdp.eval(`JSON.stringify({
  url: location.href.slice(0, 130),
  title: document.title.slice(0, 60),
  items: [...document.querySelectorAll('li, [role="button"]')].map(n => (n.innerText||'').trim()).filter(t => t && t.length < 60 && /pizza|margherita|mozzarella/i.test(t)).slice(0, 10),
})`);
console.log(JSON.parse(info));
cdp.close();
