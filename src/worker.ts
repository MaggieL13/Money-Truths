import { createMcpHandler } from "agents/mcp/server";
import { d1Db, type Db } from "./db.ts";
import { buildMcpServer } from "./mcp.ts";
import { Core } from "./core/index.ts";
import { readSettings, keyScope, timingSafeEqual } from "./setup.ts";

export interface Env {
  DB: D1Database;
  /** One-time passphrase chosen while deploying; unlocks /setup. */
  SETUP_CODE?: string;
  /** Optional fixed keys (advanced). Normally keys are issued by /setup and stored hashed in D1. */
  LEDGER_TOKEN?: string;
  LEDGER_READ_TOKEN?: string;
  /** Short git commit, injected by `npm run deploy`. */
  BUILD_SHA?: string;
}

// URL layout. Every private route sits behind a key so connectors that cannot
// send headers (claude.ai, ChatGPT) still authenticate:
//
//   /setup                  first-run setup, and new links later (needs SETUP_CODE)
//   /<key>/mcp              MCP (Streamable HTTP)
//   /<key>/api/...          JSON API (src/http.ts)
//   /<key>/                 report (?m=YYYY-MM, ?y=YYYY, ?q=...)
//   /<key>/widget           phone card · /<key>/widget.json for widget apps
//   /<key>/closed/YYYY-MM   frozen month-close page
//
// `Authorization: Bearer <key>` on the bare paths works too. A read key gets
// reports, widget, read API and read-only MCP tools.

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const db = d1Db(env.DB);

    try {
      if (url.pathname === "/setup" || url.pathname === "/setup/") {
        const { handleSetup } = await import("./setup-route.ts");
        return await handleSetup(request, url, db, env);
      }

      const auth = await authenticate(url, request, env, db);
      if (!auth) {
        // A brand-new copy sends its owner to setup; afterwards the root is just a 404.
        if (url.pathname === "/" && !(await readSettings(db))) return Response.redirect(`${url.origin}/setup`, 302);
        return new Response("Not found", { status: 404 });
      }
      const settings = await readSettings(db);
      if (!settings) return Response.redirect(`${url.origin}/setup`, 302);
      const readOnly = auth.scope === "read";

      const actorFor = (surface: string) => `${surface}${readOnly ? ":read" : ""}`;
      const core = (surface: string) => new Core(db, { timezone: settings.timezone, baseCurrency: settings.currency, actor: actorFor(surface) });

      if (auth.path === "/mcp") {
        // Stateless: one server instance per request, closing over this request's bindings.
        const handler = createMcpHandler(() => buildMcpServer(core("mcp"), { readOnly, buildSha: env.BUILD_SHA }), {
          route: auth.mcpRoute,
          allowedHostnames: [url.hostname],
        });
        return await handler(request, env, ctx);
      }

      if (auth.path.startsWith("/api/")) {
        const { handleApi } = await import("./http.ts");
        return await handleApi(request, auth.path.slice("/api".length), core("api"), { readOnly, buildSha: env.BUILD_SHA });
      }

      if (auth.path === "/widget" || auth.path === "/widget.json") {
        const { loadView } = await import("./core/report-data.ts");
        const { widgetData, renderWidget } = await import("./widget.ts");
        const view = await loadView(core("widget"));
        if (auth.path === "/widget.json") {
          return new Response(JSON.stringify(widgetData(view)), {
            headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
          });
        }
        return html(renderWidget(view));
      }

      const closed = /^\/closed\/(\d{4}-(?:0[1-9]|1[0-2]))$/.exec(auth.path);
      if (closed) {
        const row = await db.get<{ report_html: string }>("SELECT report_html FROM month_close_exports WHERE month = ?", [closed[1]]);
        if (!row?.report_html) return new Response("That month isn't closed.", { status: 404 });
        return html(row.report_html);
      }

      if (auth.path === "/" || auth.path === "") {
        const { renderReport } = await import("./report.ts");
        return html(await renderReport(core("report"), url));
      }
    } catch (e) {
      console.error(e);
      return new Response("Ledger error — check the Worker logs.", { status: 500 });
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

export function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex",
    },
  });
}

type Auth = { path: string; mcpRoute: string; scope: "write" | "read" };

async function authenticate(url: URL, request: Request, env: Env, db: Db): Promise<Auth | null> {
  const segments = url.pathname.split("/").filter(Boolean);
  const header = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]?.trim();

  const scopeOf = async (key: string): Promise<"write" | "read" | null> => {
    if (key.length < 32) return null;
    if (env.LEDGER_TOKEN && env.LEDGER_TOKEN.length >= 32 && timingSafeEqual(key, env.LEDGER_TOKEN)) return "write";
    if (env.LEDGER_READ_TOKEN && env.LEDGER_READ_TOKEN.length >= 32 && timingSafeEqual(key, env.LEDGER_READ_TOKEN)) return "read";
    return keyScope(db, key);
  };

  if (segments.length > 0) {
    const scope = await scopeOf(segments[0]);
    if (scope) return { path: "/" + segments.slice(1).join("/"), mcpRoute: `/${segments[0]}/mcp`, scope };
  }
  if (header) {
    const scope = await scopeOf(header);
    if (scope) return { path: url.pathname, mcpRoute: "/mcp", scope };
  }
  return null;
}
