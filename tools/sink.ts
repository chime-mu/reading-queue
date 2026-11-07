// Sink for the browser crawl (tools/crawl.js). The Playwright MCP server process cannot
// touch the filesystem (no `require`, no `process`), but it can make HTTP requests, so
// the crawl script POSTs each page's text here and GETs its work list. Local only.
//
//   bun tools/sink.ts &          GET /<name> reads a file from the work dir; POST {name, body} writes one.
//
// Work dir: $CRAWL_WORK, default .playwright-mcp/work (gitignored) at the repo root.
const W = process.env.CRAWL_WORK ?? `${import.meta.dir}/../.playwright-mcp/work`;
Bun.serve({
  port: 4399,
  hostname: "127.0.0.1",
  async fetch(req) {
    // CORS: page-context scripts (Claude in Chrome's javascript_tool) POST from any origin.
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Private-Network": "true" };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    const name = decodeURIComponent(new URL(req.url).pathname.slice(1));
    if (name && !/^[\w.-]+$/.test(name)) return new Response("bad name", { status: 400, headers: cors });
    if (req.method === "GET") {
      const f = Bun.file(`${W}/${name}`);
      return (await f.exists()) ? new Response(f, { headers: cors }) : new Response("missing", { status: 404, headers: cors });
    }
    const { name: n, body } = (await req.json()) as { name: string; body: string };
    if (!/^[\w.-]+$/.test(n)) return new Response("bad name", { status: 400, headers: cors });
    await Bun.write(`${W}/${n}`, body);
    return new Response("saved", { headers: cors });
  },
});
console.log("sink on 127.0.0.1:4399 →", W);
