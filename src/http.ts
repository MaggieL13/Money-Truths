import type { Core } from "./core/index.ts";
import { TOOLS, callTool } from "./tools.ts";
import { versionLabel } from "./version.ts";

// JSON API over the same tool registry as MCP, usable without MCP.
//
//   GET  /api/health
//   GET  /api/export                    full JSON backup (write token only)
//   GET  /api/tools                     list tools and whether they mutate
//   GET  /api/<read tool>?arg=value     e.g. /api/money_get_snapshot
//   POST /api/<tool>   { ...args }      any tool; writes need a write token

export async function handleApi(request: Request, path: string, core: Core, opts: { readOnly: boolean; buildSha?: string | null }): Promise<Response> {
  if (path === "/health") return json({ ok: true, version: versionLabel(opts.buildSha), info: await core.describe() });
  if (path === "/export" && request.method === "GET") {
    if (opts.readOnly) return json({ error: "Exports need the full-access token." }, 403);
    const { exportAll } = await import("./core/backup.ts");
    return new Response(JSON.stringify(await exportAll(core.db, core.now())), {
      headers: { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="money-truths-${core.today()}.json"`, "cache-control": "no-store" },
    });
  }
  if (path === "/tools" && request.method === "GET") {
    return json(TOOLS.filter((t) => !(t.mutating && opts.readOnly)).map((t) => ({ name: t.name, mutating: t.mutating, description: t.description })));
  }

  const name = path.replace(/^\//, "");
  if (!/^money_[a-z_]+$/.test(name)) return json({ error: "not found" }, 404);

  let args: unknown;
  if (request.method === "GET") {
    const tool = TOOLS.find((t) => t.name === name);
    if (tool?.mutating) return json({ error: "Use POST for tools that change data." }, 405);
    args = Object.fromEntries([...new URL(request.url).searchParams].map(([k, v]) => [k, coerce(v)]));
  } else if (request.method === "POST") {
    try {
      args = await request.json();
    } catch {
      return json({ error: "Body must be JSON." }, 400);
    }
  } else {
    return json({ error: "Method not allowed." }, 405);
  }

  const r = await callTool(core, name, args, opts);
  return r.ok ? json(r.result) : json({ error: r.error }, r.status);
}

function coerce(v: string): unknown {
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+$/.test(v) && v.length < 16) return Number(v);
  return v;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
