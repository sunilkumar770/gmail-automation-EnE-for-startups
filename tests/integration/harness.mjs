// ============================================================================
// tests/integration/harness.mjs — realistic local Supabase emulation
// ----------------------------------------------------------------------------
//   Postgres (real, local cluster)  ← v1+v2 migrations applied
//   PostgREST (real binary)         ← same REST/RPC semantics as Supabase
//   /rest/v1 proxy                  ← mimics Supabase's Kong path layout
//   Mock Resend                     ← stateful: idempotency store, failure
//                                      modes, latency, accept-then-destroy
//   Deno edge function              ← the REAL deployed artifact
// ============================================================================
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { writeFileSync, mkdtempSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(__dirname, "../..");

export const DB_NAME = process.env.TEST_DB || "gr_v2_it";
export const JWT_SECRET = "test-jwt-secret-0123456789abcdef0123456789abcdef";
export const INTERNAL_SECRET = "itest-internal-secret-value";

// ---------------------------------------------------------------------------
// JWT (HS256) — what Supabase's service_role key is
// ---------------------------------------------------------------------------
const b64url = (buf) => Buffer.from(buf).toString("base64url");
export function makeJwt(role = "service_role") {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ role, iss: "supabase-test", iat: now - 60, exp: now + 86400 }));
  const sig = createHmac("sha256", JWT_SECRET).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}
export const SERVICE_ROLE_KEY = makeJwt("service_role");

// ---------------------------------------------------------------------------
// psql helper (superuser via unix socket, like the SQL editor)
// ---------------------------------------------------------------------------
export function psql(sql, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "grsql-"));
  const file = join(dir, "q.sql");
  writeFileSync(file, sql);
  chmodSync(file, 0o644);   // postgres user must be able to read it
  chmodSync(dir, 0o755);
  try {
    const out = execFileSync("su", ["postgres", "-c",
      `psql -d ${DB_NAME} -tA -q -v ON_ERROR_STOP=1 ${opts.noStop ? "" : ""}-f ${file}`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return out.trim();
  } finally {
    try { execFileSync("rm", ["-rf", dir]); } catch { /* noop */ }
  }
}
export const psqlOne = (sql) => psql(sql).split("\n")[0] ?? "";

// ---------------------------------------------------------------------------
// PostgREST (real binary, run as postgres over the unix socket)
// ---------------------------------------------------------------------------
const PGRST_PORT = Number(process.env.PGRST_PORT || 3001);
const PROXY_PORT = Number(process.env.PROXY_PORT || 3002);
export const RESEND_MOCK_PORT = Number(process.env.RESEND_MOCK_PORT || 3003);

import { readdirSync, readFileSync } from "node:fs";
export function killByCmdline(needle) {
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let cmd = "";
    try { cmd = readFileSync(`/proc/${entry}/cmdline`, "latin1").replace(/\0/g, " "); } catch { continue; }
    if (cmd.includes(needle) && !cmd.includes("kill_stale")) {
      try { process.kill(Number(entry), "SIGKILL"); } catch { /* gone */ }
    }
  }
}

async function assertPortFree(port, what) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
    throw new Error(`port ${port} busy (${what}) — stale process? pkill -f postgrest; pkill -f 'deno run'`);
  } catch (err) {
    if (err.message.includes("port")) throw err;
    // connection refused → free ✓
  }
}

async function waitForPort(port, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`);
      if (r.status < 500) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/** Bootstrap the integration database if needed (stubs + migrations 000+001). */
export function ensureTestDb() {
  const exists = (() => {
    try {
      const out = execFileSync("su", ["postgres", "-c",
        `psql -tAc "select count(*) from pg_database where datname='${DB_NAME}'"`],
        { encoding: "utf8" }).trim();
      return out === "1";
    } catch { return false; }
  })();
  if (!exists) {
    console.log(`[harness] creating ${DB_NAME} …`);
    execFileSync("su", ["postgres", "-c", `createdb ${DB_NAME}`], { stdio: "ignore" });
  }
  // Always (re-)apply the full migration chain: every migration is idempotent,
  // and this guarantees the test DB matches the repo even after new migrations
  // land (e.g. 002 on a DB bootstrapped at 001).
  console.log(`[harness] applying stubs + migrations to ${DB_NAME} …`);
  for (const f of ["scripts/test_harness_stubs.sql",
                   "supabase/migrations/000_email_system_init.sql",
                   "supabase/migrations/001_email_system_v2.sql",
                   "supabase/migrations/002_business_defaults_and_producers.sql"]) {
    execFileSync("su", ["postgres", "-c",
      `psql -d ${DB_NAME} -q -v ON_ERROR_STOP=1 -f ${resolve(PROJECT_ROOT, f)}`],
      { stdio: "ignore" });
  }
}

export async function startHarness() {
  ensureTestDb();
  await assertPortFree(PGRST_PORT, "PostgREST");
  await assertPortFree(PROXY_PORT, "proxy");
  await assertPortFree(RESEND_MOCK_PORT, "resend mock");

  // ---- PostgREST ----
  const conf = join(tmpdir(), `pgrst-${randomUUID().slice(0, 8)}.conf`);
  writeFileSync(conf, [
    `db-uri = "postgres:///${DB_NAME}?host=/var/run/postgresql"`,
    'db-schemas = "public"',
    'db-anon-role = "anon"',
    `jwt-secret = "${JWT_SECRET}"`,
    'server-host = "127.0.0.1"',
    `server-port = ${PGRST_PORT}`,
    'log-level = "warn"',
    "",
  ].join("\n"));
  chmodSync(conf, 0o644);   // postgres must read the config
  const pgrst = spawn("su", ["postgres", "-c", `/usr/local/bin/postgrest ${conf}`], { stdio: "ignore" });
  if (!await waitForPort(PGRST_PORT)) throw new Error("PostgREST did not start");

  // ---- /rest/v1 proxy (mimics Supabase Kong path layout) ----
  const proxy = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const body = Buffer.concat(chunks);
      const path = req.url.startsWith("/rest/v1") ? req.url.slice("/rest/v1".length) : req.url;
      try {
        const upstream = await fetch(`http://127.0.0.1:${PGRST_PORT}${path}`, {
          method: req.method,
          headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => k !== "host")),
          body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
        });
        const ubuf = Buffer.from(await upstream.arrayBuffer());
        res.writeHead(upstream.status, Object.fromEntries(upstream.headers.entries()));
        res.end(ubuf);
      } catch (err) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(err?.message ?? err) }));
      }
    });
  });
  await new Promise((r) => proxy.listen(PROXY_PORT, "127.0.0.1", r));

  // ---- Mock Resend (stateful) ----
  const resendState = {
    mode: "ok",                 // ok | 429 | 403suppressed | 500 | 422
    latencyMs: 0,
    destroyOnceKeys: new Set(), // accept-then-destroy these idempotency keys once
    destroyedKeys: new Set(),
    malformedOnceKeys: new Set(), // provider accepted, but 200 carries no id (ambiguous)
    malformedServedKeys: new Set(),
    idempotency: new Map(),     // key → {id, to, subject}
    accepted: [],               // unique logical accepts (post-idempotency)
    requests: [],               // every request received (incl. replays)
  };
  const resend = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      let parsed = {};
      try { parsed = JSON.parse(raw); } catch { /* keep {} */ }
      const key = req.headers["idempotency-key"] || `anon-${randomUUID()}`;
      resendState.requests.push({ t: Date.now(), key, to: parsed.to?.[0], subject: parsed.subject, headers: parsed.headers, tags: parsed.tags, html: parsed.html, text: parsed.text });

      const finish = (status, obj, extraHeaders = {}) => {
        try {
          res.writeHead(status, { "content-type": "application/json", ...extraHeaders });
          res.end(JSON.stringify(obj));
        } catch { /* client vanished (crash injection) — accepted state already recorded */ }
      };

      const serve = () => {
        // destroy-after-accept injection: the provider DID accept, but the
        // response never reaches the worker (the ambiguous-outcome scenario).
        if (resendState.destroyOnceKeys.has(key) && !resendState.destroyedKeys.has(key)) {
          resendState.destroyedKeys.add(key);
          if (!resendState.idempotency.has(key)) {
            resendState.idempotency.set(key, { id: `resend_${randomUUID().slice(0, 12)}`, to: parsed.to?.[0], subject: parsed.subject });
            resendState.accepted.push({ key, to: parsed.to?.[0], subject: parsed.subject });
          }
          res.socket.destroy(); // worker sees a network error → UNKNOWN
          return;
        }
        // Ambiguous-success injection: provider DID accept (idempotency stored),
        // but the 200 response is unusable — the worker cannot know the id.
        if (resendState.malformedOnceKeys.has(key) && !resendState.malformedServedKeys.has(key)) {
          resendState.malformedServedKeys.add(key);
          if (!resendState.idempotency.has(key)) {
            const rec = { id: `resend_${randomUUID().slice(0, 12)}`, to: parsed.to?.[0], subject: parsed.subject };
            resendState.idempotency.set(key, rec);
            resendState.accepted.push({ key, to: rec.to, subject: rec.subject });
          }
          return finish(200, { malformed: true });
        }
        // Provider-side idempotency: same key → same stored response, no re-send.
        if (resendState.idempotency.has(key)) {
          const stored = resendState.idempotency.get(key);
          return finish(200, { id: stored.id });
        }
        switch (resendState.mode) {
          case "429": return finish(429, { statusCode: 429, message: "Too many requests" }, { "retry-after": "1" });
          case "403suppressed": return finish(403, { statusCode: 403, message: "Recipient is on the suppression list" });
          case "500": return finish(500, { statusCode: 500, message: "Internal error" });
          case "422": return finish(422, { statusCode: 422, message: "Invalid recipient address" });
          default: {
            const rec = { id: `resend_${randomUUID().slice(0, 12)}`, to: parsed.to?.[0], subject: parsed.subject };
            resendState.idempotency.set(key, rec);
            resendState.accepted.push({ key, to: rec.to, subject: rec.subject });
            return finish(200, { id: rec.id });
          }
        }
      };

      const safeServe = () => { try { serve(); } catch { /* socket destroyed by crash test */ } };
      if (resendState.latencyMs > 0) setTimeout(safeServe, resendState.latencyMs);
      else safeServe();
    });
  });
  await new Promise((r) => resend.listen(RESEND_MOCK_PORT, "127.0.0.1", r));

  const hardExit = (code, why) => {
    try { console.error(`[harness] ${why} — tearing down`); } catch { /* noop */ }
    try { pgrst.kill("SIGKILL"); } catch { /* noop */ }
    try { proxy.close(); resend.close(); } catch { /* noop */ }
    process.exit(code);
  };
  process.on("uncaughtException", (e) => hardExit(1, `uncaught: ${e?.message ?? e}`));
  process.on("unhandledRejection", (e) => hardExit(1, `unhandled rejection: ${e?.message ?? e}`));

  return {
    pgrst, proxy, resend, resendState,
    supabaseUrl: `http://127.0.0.1:${PROXY_PORT}`,
    resendUrl: `http://127.0.0.1:${RESEND_MOCK_PORT}/emails`,
    async stop() {
      try { pgrst.kill("SIGKILL"); } catch { /* noop */ }
      // `su` wrapper death orphans the real postgrest — kill by its unique
      // config-file name via /proc scan (precise: no cross-instance kills).
      killByCmdline(conf);
      try { proxy.close(); } catch { /* noop */ }
      try { resend.close(); } catch { /* noop */ }
    },
  };
}

// ---------------------------------------------------------------------------
// Edge function spawner (the REAL Deno artifact)
// ---------------------------------------------------------------------------
function findDeno() {
  const candidates = [
    process.env.DENO_BIN,
    ["", "home", "user", ".deno", "bin", "deno"].join("/"),
    join(process.env.HOME ?? "/root", ".deno/bin/deno"),
    "/root/.deno/bin/deno",
    "/usr/local/bin/deno",
  ].filter(Boolean);
  for (const c of candidates) {
    try { execFileSync(c, ["--version"], { stdio: "ignore" }); return c; } catch { /* next */ }
  }
  try {
    const w = execFileSync("which", ["deno"], { encoding: "utf8" }).trim();
    if (w) return w;
  } catch { /* not on PATH */ }
  throw new Error("deno binary not found — set DENO_BIN or install Deno");
}

export async function spawnEdge(port, h, overrides = {}) {
  await assertPortFree(port, `edge fn ${port}`);
  const child = spawn(
    findDeno(),
    ["run", "--allow-net", "--allow-env", "--allow-read",
     join(PROJECT_ROOT, "supabase/functions/notify-lifecycle/index.ts")],
    {
      env: {
        ...process.env,
        PORT: String(port),
        SUPABASE_URL: h.supabaseUrl,
        SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
        EMAIL_INTERNAL_SECRET: INTERNAL_SECRET,
        RESEND_API_KEY: "re_test_key",
        RESEND_API_URL: h.resendUrl,
        RESEND_FROM_EMAIL: "GoRentals <bookings@gorentals.com>",
        APP_URL: "https://gorentals.test",
        RATE_RPS: "200", RATE_BURST: "50",     // fast tests; bucket still exercised
        RESEND_TIMEOUT_MS: "3000",
        DRAIN_TIME_BUDGET_MS: "30000",
        ...overrides,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const dbg = !!process.env.DEBUG_EDGE;
  const logs = [];
  child.stderr.on("data", (d) => { logs.push(String(d)); if (dbg) console.error("[edge:err]", String(d).trim().slice(0, 300)); });
  child.stdout.on("data", (d) => { logs.push(String(d)); if (dbg) console.error("[edge]", String(d).trim().slice(0, 500)); });
  const base = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(base); if (r.ok) break; } catch { /* wait */ }
    if (Date.now() - t0 > 25000) throw new Error(`edge fn on ${port} did not start`);
    await new Promise((r) => setTimeout(r, 250));
  }
  const call = async (body, headers = {}) => {
    const r = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-secret": INTERNAL_SECRET, ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    let j = null;
    try { j = await r.json(); } catch { /* non-json */ }
    return { status: r.status, body: j };
  };
  return { child, base, call, logs, kill: (sig = "SIGKILL") => child.kill(sig) };
}

// ---------------------------------------------------------------------------
// Test-data helpers
// ---------------------------------------------------------------------------
export function cleanTestData() {
  psql(`
    delete from public.email_send_attempts where outbox_id in
      (select id from public.email_outbox where recipient like '%@itest.local'
       or logical_event_id like 'CHAOS:%' or logical_event_id like 'ITEST%' or logical_event_id like 'WIN_BACK:%ITEST.LOCAL%');
    delete from public.email_outbox where recipient like '%@itest.local'
      or logical_event_id like 'CHAOS:%' or logical_event_id like 'ITEST%';
    delete from public.email_provider_events where provider_event_id like 'itest-%';
    delete from public.email_suppressions where email like '%@itest.local';
    -- refunds BEFORE bookings (FK order); cover every fixture range any suite uses
    delete from public.refunds where booking_id::text like 'eeeeeeee-%'
      or booking_id::text like 'cccccccc-%' or booking_id::text like 'ffffffff-%' or id::text like 'eeeeeeee-%' or id::text like 'dddddddd-%';
    delete from public.bookings where id::text like 'eeeeeeee-%' or id::text like 'cccccccc-%' or id::text like 'ffffffff-%';
    delete from public.listings where id::text like 'eeeeeeee-%' or id::text like 'bbbbbbbb-%';
    delete from public.profiles where id::text like 'eeeeeeee-%' or id::text like 'aaaaaaaa-%';
    delete from auth.users where id::text like 'eeeeeeee-%' or id::text like 'aaaaaaaa-%';
    delete from public.email_runtime_state where key='drain';
    update public.email_config set value='trigger' where key='enqueue_source';
  `);
}

let checkPass = 0, checkFail = 0;
export function check(name, cond, extra = "") {
  if (cond) { checkPass++; console.log("PASS  " + name); }
  else { checkFail++; console.log("FAIL  " + name + (extra ? "  ⟵ " + extra : "")); }
}
export function testSummary(label) {
  console.log(`\n${label}: ${checkPass} passed, ${checkFail} failed`);
  return checkFail === 0;
}
export function resetCounters() { checkPass = 0; checkFail = 0; }
export { randomUUID };
