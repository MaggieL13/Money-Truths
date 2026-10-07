import type { Db } from "./db.ts";
import { isCurrencyCode } from "./money.ts";

// First-run setup and access keys.
//
// A fresh copy has an empty database and a SETUP_CODE secret the owner typed
// while deploying. /setup asks for that code plus their name, main currency
// and timezone, creates the primary owner, and issues two random links:
// full access (for Claude / ChatGPT) and read-only (report and phone widget).
// Only SHA-256 hashes of the keys are stored, so the links are shown once.
// The same page can issue new links later (old ones stop working).

export interface Settings {
  timezone: string;
  currency: string;
  ownerName: string;
}

export const PRIMARY_ID = "me";

export async function readSettings(db: Db): Promise<Settings | null> {
  const rows = await db.all<{ key: string; value: string }>("SELECT key, value FROM schema_meta WHERE key IN ('timezone', 'base_currency')");
  const meta = new Map(rows.map((r) => [r.key, r.value]));
  const owner = await db.get<{ name: string }>("SELECT name FROM owners WHERE is_primary = 1 ORDER BY rowid LIMIT 1");
  if (!owner || !meta.get("timezone") || !meta.get("base_currency")) return null;
  return { timezone: meta.get("timezone")!, currency: meta.get("base_currency")!, ownerName: owner.name };
}

export function isTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz.length > 0;
  } catch {
    return false;
  }
}

export class SetupError extends Error {}

/** Create the primary owner and settings. Refuses if already set up. */
export async function initialize(db: Db, a: { name: string; currency: string; timezone: string; now: string }): Promise<void> {
  const name = a.name.trim();
  const currency = a.currency.trim().toUpperCase();
  const timezone = a.timezone.trim();
  if (!name || name.length > 60) throw new SetupError("Please enter your name (up to 60 characters).");
  if (!isCurrencyCode(currency) || !validCurrency(currency)) throw new SetupError(`"${a.currency}" isn't a currency code. Use 3 letters, like USD, EUR, GBP or MXN.`);
  if (!isTimezone(timezone)) throw new SetupError(`"${a.timezone}" isn't a timezone. Use a name like America/New_York or Europe/Madrid.`);
  if (await readSettings(db)) throw new SetupError("This ledger is already set up.");
  await db.batch([
    { sql: "INSERT INTO owners (id, name, is_primary) VALUES (?, ?, 1)", params: [PRIMARY_ID, name] },
    ...[
      ["base_currency", currency],
      ["timezone", timezone],
      ["setup_at", a.now],
      ["report_eyebrow", `${name}'s ledger`],
    ].map(([k, v]) => ({ sql: "INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params: [k, v] })),
  ]);
}

function validCurrency(c: string): boolean {
  try {
    // Intl accepts any well-formed code; supportedValuesOf knows the real ones.
    const known = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("currency");
    return known ? known.includes(c) : true;
  } catch {
    return true;
  }
}

/** Revoke every key and issue a fresh write + read pair. Returns the plaintext keys (shown once). */
export async function issueKeys(db: Db, now: string): Promise<{ write: string; read: string }> {
  const write = randomKey();
  const read = randomKey();
  await db.batch([
    { sql: "UPDATE access_keys SET revoked_at = ? WHERE revoked_at IS NULL", params: [now] },
    { sql: "INSERT INTO access_keys (id, scope, key_hash, label, created_at) VALUES (?, 'write', ?, 'full access', ?)", params: [crypto.randomUUID(), await sha256(write), now] },
    { sql: "INSERT INTO access_keys (id, scope, key_hash, label, created_at) VALUES (?, 'read', ?, 'read only', ?)", params: [crypto.randomUUID(), await sha256(read), now] },
  ]);
  return { write, read };
}

/** Scope of a presented key, or null. */
export async function keyScope(db: Db, key: string): Promise<"write" | "read" | null> {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(key)) return null;
  const row = await db.get<{ scope: "write" | "read" }>("SELECT scope FROM access_keys WHERE key_hash = ? AND revoked_at IS NULL", [await sha256(key)]);
  return row?.scope ?? null;
}

function randomKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- Setup code checks, with a brake on guessing --------------------------------

const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000;

export async function checkSetupCode(db: Db, configured: string | undefined, given: string, nowMs: number): Promise<"ok" | "wrong" | "locked" | "unconfigured"> {
  if (!configured || configured.trim().length < 8) return "unconfigured";
  const row = await db.get<{ value: string }>("SELECT value FROM schema_meta WHERE key = 'setup_failures'");
  const state = row ? (JSON.parse(row.value) as { n: number; first: number }) : { n: 0, first: nowMs };
  const fresh = nowMs - state.first > WINDOW_MS ? { n: 0, first: nowMs } : state;
  if (fresh.n >= MAX_FAILURES) return "locked";
  if (timingSafeEqual(given.trim(), configured.trim())) {
    if (row) await db.run("DELETE FROM schema_meta WHERE key = 'setup_failures'");
    return "ok";
  }
  const next = { n: fresh.n + 1, first: fresh.n === 0 ? nowMs : fresh.first };
  await db.run("INSERT INTO schema_meta (key, value) VALUES ('setup_failures', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify(next)]);
  return "wrong";
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---- Pages ---------------------------------------------------------------------------

const CSS = `:root{--bg:#111014;--card:#1a171e;--raised:#221d27;--border:#3a303e;--text:#f4edf5;--muted:#b7aeb9;--gold:#e0bd72;--violet:#9a78d1;--good:#aee3bc;--bad:#ffb5bb;--bad-bg:#3b2327}
@media (prefers-color-scheme: light){:root{--bg:#f7f4f8;--card:#fff;--raised:#f1ecf3;--border:#ddd3e0;--text:#1d1820;--muted:#665d69;--gold:#8a6a1f;--violet:#6b4aa8;--good:#2f7a47;--bad:#a3333d;--bad-bg:#fbe9eb}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px 16px}
main{max-width:560px;margin:auto}
.eb{color:var(--gold);font-size:12px;font-weight:750;letter-spacing:.14em;text-transform:uppercase;margin:0}
h1{font-size:28px;margin:4px 0 8px}
p{color:var(--muted)}
.card{background:var(--card);border:1px solid var(--border);border-radius:18px;padding:18px;margin:16px 0}
label{display:block;font-weight:600;margin:14px 0 6px}
label small{display:block;font-weight:400;color:var(--muted);font-size:13px}
input,select{width:100%;font:inherit;padding:10px 12px;border-radius:10px;border:1px solid var(--border);background:var(--raised);color:var(--text)}
button{font:inherit;font-weight:700;border:0;border-radius:999px;padding:11px 20px;background:var(--violet);color:#fff;cursor:pointer;margin-top:18px}
button.ghost{background:var(--raised);color:var(--text);border:1px solid var(--border);margin:0;padding:6px 12px;font-size:14px}
.err{background:var(--bad-bg);color:var(--bad);border-radius:12px;padding:10px 12px;font-weight:600}
.link{display:flex;gap:8px;align-items:center;margin-top:6px}
.link code{flex:1;min-width:0;overflow-wrap:anywhere;background:var(--raised);border-radius:10px;padding:8px 10px;font-size:13px}
ol{color:var(--muted);padding-left:20px}ol li{margin:4px 0}
.warn{border-color:var(--gold)}
b{color:var(--text)}`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body><main>
<p class="eb">Money Truths</p>
${body}
</main></body>
</html>`;
}

export function unconfiguredPage(): string {
  return page(
    "Almost there",
    `<h1>Almost there</h1>
<div class="card">
<p>This copy doesn't have a <b>setup code</b> yet, so nobody can set it up — that keeps strangers out.</p>
<ol>
<li>Open your Cloudflare dashboard → <b>Workers &amp; Pages</b> → this worker → <b>Settings</b> → <b>Variables and Secrets</b>.</li>
<li>Add a <b>Secret</b> named <code>SETUP_CODE</code> with any passphrase you'll remember (at least 8 characters).</li>
<li>Deploy, then reload this page.</li>
</ol>
</div>`,
  );
}

export function setupForm(error?: string, values: { name?: string; currency?: string; timezone?: string } = {}): string {
  return page(
    "Set up Money Truths",
    `<h1>Welcome 💜</h1>
<p>Let's set up your private ledger. This takes a minute and only happens once.</p>
${error ? `<p class="err">${esc(error)}</p>` : ""}
<form class="card" method="post" action="setup">
<input type="hidden" name="action" value="setup">
<label for="code">Setup code<small>The passphrase you typed as SETUP_CODE when you deployed.</small></label>
<input name="code" id="code" type="password" required autocomplete="off">
<label for="name">Your name<small>Shown on your report. A nickname is fine.</small></label>
<input name="name" id="name" required maxlength="60" value="${esc(values.name ?? "")}">
<label for="currency">Main currency<small>The money you use most. Accounts in other currencies still work.</small></label>
<input name="currency" id="currency" required maxlength="3" value="${esc(values.currency ?? "")}" placeholder="USD" style="text-transform:uppercase">
<label for="tz">Timezone<small id="tzhint">Already picked from this device — just check the clock looks right.</small></label>
<input name="timezone" id="tz" required value="${esc(values.timezone ?? "")}" placeholder="America/New_York">
<button type="submit">Create my ledger</button>
</form>
<script>
// Swap the plain text boxes for dropdowns, pre-filled from this device.
// Without JavaScript the text boxes still work.
(() => {
  const swap = (input, options, chosen) => {
    const sel = document.createElement("select");
    sel.name = input.name; sel.id = input.id; sel.required = true;
    for (const [value, label] of options) {
      const o = document.createElement("option");
      o.value = value; o.textContent = label;
      if (value === chosen) o.selected = true;
      sel.appendChild(o);
    }
    input.replaceWith(sel);
    return sel;
  };
  const supported = (k) => { try { return Intl.supportedValuesOf(k); } catch (_) { return null; } };

  // Timezone: every zone, labelled with its city and the time there right now.
  const tzInput = document.getElementById("tz");
  let here = tzInput.value;
  if (!here) try { here = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (_) {}
  const zones = supported("timeZone");
  if (zones) {
    if (here && !zones.includes(here)) zones.unshift(here);
    const now = new Date();
    const clock = (z) => { try { return now.toLocaleTimeString([], { timeZone: z, hour: "numeric", minute: "2-digit" }); } catch (_) { return ""; } };
    const city = (z) => z.split("/").slice(1).join(" / ").replace(/_/g, " ") || z;
    const sel = swap(tzInput, zones.map((z) => [z, city(z) + " (" + z.split("/")[0] + ") — " + clock(z)]), here);
    const hint = document.getElementById("tzhint");
    const show = () => (hint.textContent = "It's " + clock(sel.value) + " there right now. If that matches your clock, you're all set.");
    sel.onchange = show;
    if (here) show();
  } else if (!tzInput.value) tzInput.value = here;

  // Currency: common ones first, by name; then every other currency.
  const curInput = document.getElementById("currency");
  let mine = curInput.value;
  if (!mine) {
    const region = (navigator.language || "").split("-")[1] || "";
    mine = { US: "USD", GB: "GBP", CA: "CAD", AU: "AUD", MX: "MXN", BR: "BRL", AR: "ARS", CL: "CLP", CO: "COP", PE: "PEN", PY: "PYG", UY: "UYU", BO: "BOB", VE: "VES", JP: "JPY", KR: "KRW", IN: "INR", PH: "PHP", ES: "EUR", FR: "EUR", DE: "EUR", IT: "EUR", PT: "EUR", NL: "EUR", IE: "EUR", BE: "EUR", AT: "EUR", FI: "EUR", NZ: "NZD", ZA: "ZAR", SE: "SEK", NO: "NOK", DK: "DKK", PL: "PLN", CH: "CHF" }[region] || "USD";
  }
  const all = supported("currency");
  if (all) {
    let names = null;
    try { names = new Intl.DisplayNames(["en"], { type: "currency" }); } catch (_) {}
    const label = (c) => (names ? names.of(c) + " (" + c + ")" : c);
    const common = ["USD", "EUR", "GBP", "CAD", "AUD", "MXN", "BRL", "ARS", "CLP", "COP", "PEN", "PYG", "UYU", "JPY", "INR", "PHP"].filter((c) => all.includes(c));
    const rest = all.filter((c) => !common.includes(c));
    swap(curInput, [...common, ...rest].map((c) => [c, label(c)]), mine);
  } else if (!curInput.value) curInput.value = mine;
})();
</script>`,
  );
}

export function rotateForm(name: string, error?: string): string {
  return page(
    "Money Truths",
    `<h1>Hi, ${esc(name)}</h1>
<p>Your ledger is already set up. Lost your links, or think someone else has them? Get new ones here — <b>the old links stop working</b>, so you'll need to update them in Claude, ChatGPT and your phone.</p>
${error ? `<p class="err">${esc(error)}</p>` : ""}
<form class="card" method="post" action="setup">
<input type="hidden" name="action" value="rotate">
<label for="code">Setup code</label>
<input name="code" id="code" type="password" required autocomplete="off">
<button type="submit">Give me new links</button>
</form>`,
  );
}

export function linksPage(origin: string, keys: { write: string; read: string }, fresh: boolean): string {
  const mcp = `${origin}/${keys.write}/mcp`;
  const report = `${origin}/${keys.read}/`;
  const widget = `${origin}/${keys.read}/widget`;
  const row = (id: string, value: string) =>
    `<div class="link"><code id="${id}">${esc(value)}</code><button class="ghost" type="button" data-copy="${id}">Copy</button></div>`;
  return page(
    "Your links",
    `<h1>${fresh ? "You're all set ✨" : "Here are your new links"}</h1>
<div class="card warn">
<p><b>Save these somewhere private now</b> (a password manager or notes app). They are shown only once. Anyone with the first link can read and change your ledger, so don't post it anywhere.</p>
</div>
<div class="card">
<label>1 · Your AI connector link<small>Full access. Paste it into Claude or ChatGPT.</small></label>
${row("mcp", mcp)}
<ol>
<li><b>Claude</b>: Settings → Connectors → Add custom connector → paste the link.</li>
<li><b>ChatGPT</b>: Settings → Apps &amp; Connectors → Advanced → turn on Developer mode → Create → paste the link (no authentication).</li>
<li>Menus move around sometimes — look for “connectors” or “apps”, or ask your AI to walk you through it.</li>
</ol>
</div>
<div class="card">
<label>2 · Your report<small>Read-only. Open it in a browser any time.</small></label>
${row("report", report)}
<label>3 · Phone widget<small>Read-only. Open on your phone and “Add to Home screen”.</small></label>
${row("widget", widget)}
</div>
<div class="card">
<p><b>Next:</b> open a new chat with your AI and say <i>“Let's set up my Money Truths.”</i> It will ask about your accounts, cards and bills, one at a time.</p>
</div>
<script>
document.querySelectorAll("[data-copy]").forEach((b) => b.onclick = async () => {
  const text = document.getElementById(b.dataset.copy).textContent;
  try { await navigator.clipboard.writeText(text); b.textContent = "Copied ✓"; } catch (_) { b.textContent = "Select & copy"; }
  setTimeout(() => (b.textContent = "Copy"), 2000);
});
</script>`,
  );
}

/** Shown when the AI connector link is opened in a browser. */
export function connectorHelpPage(link: string, readOnly: boolean): string {
  return page(
    "Your AI connector link",
    `<h1>This link is for your AI 🤖</h1>
<p>It isn't a web page — it's the private door Claude or ChatGPT uses to read${readOnly ? "" : " and update"} your ledger. Opening it here does nothing, and that's fine.</p>
<div class="card">
<label>Paste this into your AI<small>Keep it private, like a password.</small></label>
<div class="link"><code id="mcp">${esc(link)}</code><button class="ghost" type="button" id="copy">Copy</button></div>
<ol>
<li><b>Claude</b>: Settings → Connectors → Add custom connector → paste it.</li>
<li><b>ChatGPT</b>: Settings → Apps &amp; Connectors → Advanced → Developer mode on → Create → paste it (no authentication).</li>
<li>Then start a new chat and say <i>“Let's set up my Money Truths.”</i></li>
</ol>
${readOnly ? `<p>This is your <b>read-only</b> link, so your AI will only be able to look. For an AI that can record things, use your full-access link.</p>` : ""}
</div>
<script>
document.getElementById("copy").onclick = async (e) => {
  try { await navigator.clipboard.writeText(document.getElementById("mcp").textContent); e.target.textContent = "Copied ✓"; } catch (_) { e.target.textContent = "Select & copy"; }
};
</script>`,
  );
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
