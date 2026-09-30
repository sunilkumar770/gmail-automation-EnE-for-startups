# Gmail Automation Engine — Ops Dashboard

Vite/React console for the GoRentls email system.

> ⚠️ **Two modes — know which one you're in.**
> * **Demo tabs** (Event Testbench, Transactional Outbox, Template Studio, Gmail API &
>   Quotas, Observability, Integration SDK, Forensic Report) are an **in-memory
>   simulation** for architecture demos and chaos experimentation. They send nothing.
> * **⚡ Live Ops (Real API)** calls the **deployed `notify-lifecycle` edge function** —
>   the same operator surface pg_cron and `RUNBOOK.md` use:
>   `HEALTHCHECK · ENQUEUE · TRACE · REPLAY · DRAIN_QUEUE`
>   (`src/engine/apiClient.ts`, template catalog in `src/engine/liveCatalog.ts`).

## Run locally

```bash
npm install --legacy-peer-deps   # repo is bun-lock'd; npm needs the peer flag
npm run dev                      # http://localhost:3000
```

## Connecting Live Ops to production

1. Open the **⚡ Live Ops** tab.
2. Edge function URL: `https://<project-ref>.supabase.co/functions/v1/notify-lifecycle`
3. Secret: the `EMAIL_INTERNAL_SECRET` value (Vault ↔ edge env — see `SETUP.md` Step 4).
4. **Save & Test** runs a real `HEALTHCHECK` (queue depth, caps, drain lease, inbox
   backlog) and only persists the connection on success.

The edge function sends permissive CORS headers, so the console works straight from
the browser. **Treat the secret as operator-grade**: anyone holding it can enqueue,
replay and drain. Host this dashboard behind your own auth (or run it locally),
never on a public URL. Settings persist in `localStorage` of that browser only.

`event → production template` mapping for the demo presets lives in
`liveCatalog.ts` (`EVENT_TO_TEMPLATE`); presets without a mapping
(`OWNER_PAYOUT_COMPLETED`, `SYSTEM_ALERT`) are roadmap items — see the review doc.
