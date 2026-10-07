import type { Db } from "./db.ts";
import type { Env } from "./worker.ts";
import { html } from "./worker.ts";
import { SetupError, checkSetupCode, initialize, issueKeys, linksPage, readSettings, rotateForm, setupForm, unconfiguredPage } from "./setup.ts";

// GET/POST /setup — see src/setup.ts.

export async function handleSetup(request: Request, url: URL, db: Db, env: Env): Promise<Response> {
  const settings = await readSettings(db);
  if (!env.SETUP_CODE || env.SETUP_CODE.trim().length < 8) return html(unconfiguredPage());

  if (request.method === "GET") return html(settings ? rotateForm(settings.ownerName) : setupForm());
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const form = await request.formData();
  const field = (k: string) => String(form.get(k) ?? "");
  const values = { name: field("name"), currency: field("currency"), timezone: field("timezone") };
  const retry = (msg: string) => html(settings ? rotateForm(settings.ownerName, msg) : setupForm(msg, values), 400);

  const check = await checkSetupCode(db, env.SETUP_CODE, field("code"), Date.now());
  if (check === "locked") return retry("Too many wrong codes. Wait 15 minutes and try again.");
  if (check === "unconfigured") return html(unconfiguredPage());
  if (check === "wrong") return retry("That setup code doesn't match. It's the SETUP_CODE you typed when deploying.");

  const now = new Date().toISOString();
  if (!settings) {
    if (field("action") !== "setup") return retry("Please fill in the setup form.");
    try {
      await initialize(db, { ...values, now });
    } catch (e) {
      if (e instanceof SetupError) return retry(e.message);
      throw e;
    }
  }
  const keys = await issueKeys(db, now);
  return html(linksPage(url.origin, keys, !settings));
}
