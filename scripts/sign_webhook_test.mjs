// ============================================================================
// scripts/sign_webhook_test.mjs  (svix >= 1.99 API)
// Signs a fake Resend webhook payload so you can test
// app/api/resend-webhook WITHOUT waiting for real email events.
//
// Usage:
//   npm i svix                                   # once, in the Next.js app
//   node scripts/sign_webhook_test.mjs \
//        --secret whsec_XXXX \
//        --type email.bounced \
//        [--url http://localhost:3000/api/resend-webhook]   # fires the request
//
// Without --url it prints a ready-to-paste curl command.
// NOTE: svix secrets are whsec_ + base64; verify() enforces a ~5-minute
// timestamp tolerance, so use the generated curl immediately (replay-safe).
// ============================================================================
import { Webhook } from "svix";
import { randomBytes } from "node:crypto";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  if (process.argv[i]?.startsWith("--")) args[process.argv[i].slice(2)] = process.argv[i + 1];
}

const secret = args.secret ?? `whsec_${Buffer.from(randomBytes(32)).toString("base64")}`;
const type = args.type ?? "email.bounced";
const url = args.url ?? null;

if (!secret.startsWith("whsec_")) {
  console.error("Secret must start with 'whsec_' (copy it from Resend Dashboard → Webhooks).");
  process.exit(1);
}

const emailId = crypto.randomUUID();
const now = new Date().toISOString();

const payload = {
  type,
  created_at: now,
  data: {
    created_at: now,
    email_id: emailId,
    message_id: `<test-${emailId}@gorentals.com>`,
    from: "GoRentals <bookings@gorentals.com>",
    to: ["bounced.victim@example.com"],
    subject: "Confirmed — Beachfront Camper Van on GoRentals",
    ...(type === "email.bounced"
      ? { bounce: { type: "Permanent", subType: "General", message: "smtp; 550 5.1.1 user unknown" } }
      : {}),
    ...(type === "email.complained" ? { complaint: { type: "abuse", feedbackType: "abuse" } } : {}),
    ...(type.startsWith("suppression.")
      ? { email: "bounced.victim@example.com", reason: "hard_bounce" }
      : {}),
  },
};

const body = JSON.stringify(payload);

// --- Svix signing (matches what Resend does server-side) ---
// signed content = `${msgId}.${unixSeconds}.${body}` → header value "v1,<base64 hmac-sha256>"
const msgId = `msg_${Buffer.from(randomBytes(18)).toString("base64").replace(/[^a-zA-Z0-9]/g, "x")}`;
const timestamp = new Date();
const wh = new Webhook(secret);
const signature = wh.sign(msgId, timestamp, body);

const headers = {
  "svix-id": msgId,
  "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
  "svix-signature": signature,
};

// Self-check: the signature must verify before we hand it to you.
wh.verify(body, headers);

console.log("---- signed test payload ----");
console.log(body);
console.log("\n---- headers ----");
console.log(JSON.stringify(headers, null, 2));
console.log(
  [
    "curl -sS -X POST",
    url ? "'" + url + "'" : "'https://YOUR-APP/api/resend-webhook'",
    "-H 'content-type: application/json'",
    "-H 'svix-id: " + headers["svix-id"] + "'",
    "-H 'svix-timestamp: " + headers["svix-timestamp"] + "'",
    "-H 'svix-signature: " + headers["svix-signature"] + "'",
    "--data '" + body.replaceAll("'", "'\\''") + "'",
  ].join(" \\\n  "),
);

if (url) {
  console.log("\n---- firing request ----");
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
  console.log(`HTTP ${res.status}`);
  console.log(await res.text());
}
