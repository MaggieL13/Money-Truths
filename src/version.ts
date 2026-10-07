// One version for everything that reports one: package.json (checked by a
// test), the MCP server info, the card app handshake and card footers. The
// deploy script adds the git commit as BUILD_SHA so a running copy can say
// exactly which code it is.
export const VERSION = "1.0.0";

export function versionLabel(buildSha?: string | null): string {
  return buildSha ? `v${VERSION} · ${buildSha}` : `v${VERSION}`;
}
