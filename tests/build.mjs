// ============================================================================
// tests/build.mjs — transpile/bundle TS sources so Node can execute them:
//   * lib/*          → tests/.build/lib.mjs        (unit-testable surface)
//   * webhook route  → tests/.build/route-webhook.mjs
//   * unsubscribe    → tests/.build/route-unsub.mjs
// Deno-style specifiers (npm:zod@3) are aliased to their node equivalents.
// ============================================================================
import * as esbuild from "esbuild";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootPosix = root.replace(/\\/g, "/");
const out = resolve(root, "tests/.build");
mkdirSync(out, { recursive: true });

// next/server needs the .js suffix under plain-node ESM
const shim = resolve(out, "next-server-shim.mjs");
if (!existsSync(shim)) writeFileSync(shim, 'export * from "next/server.js";\n');

// lib barrel: re-export every module for unit tests
const barrel = resolve(out, "lib-entry.ts");
writeFileSync(
  barrel,
  [
    `export * from "${rootPosix}/supabase/functions/notify-lifecycle/lib/format.ts";`,
    `export * as states from "${rootPosix}/supabase/functions/notify-lifecycle/lib/states.ts";`,
    `export * as retry from "${rootPosix}/supabase/functions/notify-lifecycle/lib/retry.ts";`,
    `export * as ratelimit from "${rootPosix}/supabase/functions/notify-lifecycle/lib/ratelimit.ts";`,
    `export * as log from "${rootPosix}/supabase/functions/notify-lifecycle/lib/log.ts";`,
    `export * as schemas from "${rootPosix}/supabase/functions/notify-lifecycle/lib/schemas.ts";`,
    `export * as templates from "${rootPosix}/supabase/functions/notify-lifecycle/lib/templates.ts";`,
  ].join("\n"),
);

const common = {
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  logLevel: "warning",
  alias: { "npm:zod@3": "zod" },
};

await esbuild.build({ ...common, entryPoints: [barrel], outfile: resolve(out, "lib.mjs") });

await esbuild.build({
  ...common,
  entryPoints: [resolve(root, "app/api/resend-webhook/route.ts")],
  outfile: resolve(out, "route-webhook.mjs"),
  alias: { ...common.alias, "next/server": "./tests/.build/next-server-shim.mjs" },
  external: ["next/server.js"],
});

await esbuild.build({
  ...common,
  entryPoints: [resolve(root, "app/api/unsubscribe/route.ts")],
  outfile: resolve(out, "route-unsub.mjs"),
  alias: { ...common.alias, "next/server": "./tests/.build/next-server-shim.mjs" },
  external: ["next/server.js"],
});

await esbuild.build({
  ...common,
  entryPoints: [resolve(root, "app/api/invoices/[id]/pdf/route.ts")],
  outfile: resolve(out, "route-pdf.mjs"),
  alias: { ...common.alias, "next/server": "./tests/.build/next-server-shim.mjs" },
  external: ["next/server.js"],
});

console.log("build ok →", out);
