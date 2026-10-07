// npm run backup: SQL dump of your Cloudflare D1 database into backups/
// (gitignored). Needs `npx wrangler login` first.
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";

mkdirSync("backups", { recursive: true });
const day = new Date().toISOString().slice(0, 10);
execSync(`npx wrangler d1 export DB --remote --output backups/money-truths-${day}.sql`, { stdio: "inherit" });
