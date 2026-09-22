export interface ReportSection {
  id: number;
  title: string;
  category: 'Forensic & Bugs' | 'Architecture & Design' | 'Engine Systems' | 'GoRentls & Domain' | 'Delivery & Certification';
  summary: string;
  content: string;
}

export const ENGINEERING_REPORT: ReportSection[] = [
  {
    id: 1,
    title: '1. Repository Forensic Report',
    category: 'Forensic & Bugs',
    summary: 'Forensic audit of github.com/sunilkumar770/gmail-automation-EnE-for-startups codebase structure, dependencies, and actual functionality.',
    content: `### Executive Forensic Summary
An exhaustive inspection of the target repository (\`sunilkumar770/gmail-automation-EnE-for-startups\`) reveals that despite the repository name indicating a "Gmail automation engine for startups", the repository in its current state contains **zero Gmail API code**. Instead, it is a custom implementation built specifically around **Supabase (PostgreSQL), Deno Edge Functions, and the 3rd-party Resend email API**.

#### Repository Tree Audit
* **Root**: \`package.json\`, \`AUDIT.md\`, \`RUNBOOK.md\`, \`SETUP.md\`, \`FAULT_INJECTION.md\`
* **Database Layer (\`supabase/migrations/\`)**:
  - \`000_email_system_init.sql\` (v1 baseline: rudimentary tables \`email_queue\`, \`email_log\`, trigger procedures)
  - \`001_email_system_v2.sql\` (v2 migration: introducing \`email_outbox\`, \`email_send_attempts\`, \`email_templates\`, \`email_provider_events\`, state machine)
  - \`002_business_defaults_and_producers.sql\` (GoRentals launch defaults, currency/timezone defaults, win-back tiers)
* **Execution & Worker (\`supabase/functions/notify-lifecycle/\`)**:
  - \`index.ts\`: Edge worker with Deno runtime calling Supabase PostgREST RPC and executing \`DRAIN_QUEUE\`
  - \`lib/resend.ts\`: Direct client calling \`api.resend.com/emails\` via fetch with \`RESEND_API_KEY\`
  - \`lib/templates.ts\`: HTML string renderers hardcoded with GoRentals branding
  - \`lib/retry.ts\`, \`lib/ratelimit.ts\`, \`lib/schemas.ts\`, \`lib/states.ts\`
* **Web Routes (\`app/api/\`)**:
  - \`app/api/resend-webhook/route.ts\`: Next.js webhook receiver for Resend/Svix events
  - \`app/api/unsubscribe/route.ts\`: HMAC token-based unsubscribe handler

#### Core Divergence from Mission
1. **No Gmail Transport**: The system is completely hardwired to Resend REST API endpoints (\`https://api.resend.com/emails\`). There is no Google OAuth2 token handshake, no RFC 2822 MIME base64url message encoder, no Gmail user quota tracking, and no thread/conversation management.
2. **Coupled to Supabase / Deno**: The engine cannot be embedded or plugged into standard Node.js, Express, Next.js, or microservice applications without deploying a complete Supabase Postgres instance and Deno runtime.
3. **No Developer SDK**: Applications cannot simply invoke \`sendEvent("BOOKING_CONFIRMED", customerId, bookingId)\`; instead, the host must write directly to specific Supabase database tables or make raw authenticated PostgREST calls.`,
  },
  {
    id: 2,
    title: '2. Verified Bugs & Defect Ledger',
    category: 'Forensic & Bugs',
    summary: 'Line-by-line verification of defects found in v1/v2 codebases including swallowed exceptions, deduplication races, and broken lifecycle triggers.',
    content: `### Verified Code Defect Ledger

| Defect ID | Severity | File / Line Reference | Defect Description & Consequence |
|---|---|---|---|
| **P0-1** | Critical | \`000_email_system_init.sql:1101-1143\` | **Triggers swallow all exceptions**: Triggers use \`EXCEPTION WHEN OTHERS THEN RAISE WARNING; RETURN NEW;\`. When email enqueue fails, the business transaction still commits but the email is silently lost forever. |
| **P0-2** | Critical | \`000_email_system_init.sql:388-431\` | **Dedupe identity is booking-scoped, not event-scoped**: \`dedupe_key = md5(template \\| recipient \\| booking_id)\`. If a customer receives two legitimate refunds for one booking, the second refund confirmation is blocked as a "duplicate". |
| **P0-3** | Critical | \`000_email_system_init.sql:1156\` | **Refund triggers on INSERT only**: If the host application inserts refunds as \`status = 'pending'\` and updates to \`status = 'completed'\`, the email trigger never fires on UPDATE, resulting in zero refund notifications. |
| **P0-4** | High | \`000_email_system_init.sql:398-401\` | **Partial unique index race**: Concurrent workers claiming the same batch can both pass the \`already_logged\` check before either writes the accepted row, causing **duplicate email delivery**. |
| **P0-5** | High | \`lib/resend.ts:487-493\` | **Ambiguous timeout treated as blind retry**: Network timeouts or HTTP 408 treated as retryable with a new idempotency key, causing double-sends if the upstream provider had in fact processed the request. |
| **P0-6** | High | \`app/api/resend-webhook/route.ts:step 4\` | **Webhook-before-worker race**: Resend can deliver \`email.sent\` webhook before the edge worker has recorded the outbox status row, causing webhook events to be logged as \`template='unknown'\` with orphaned correlation IDs. |
| **P1-1** | Medium | \`000_email_system_init.sql:377-386\` | **No Attempt Ledger**: Only an integer counter \`attempts\` exists on the queue row; individual attempt timestamps, latencies, and HTTP response codes are destroyed on subsequent retries. |
| **P1-2** | Medium | \`lib/templates.ts:559\` | **No runtime payload validation**: Missing critical fields (e.g. \`{{bookingId}}\` or \`{{startDate}}\`) rendered empty strings or dashes (\`—\`) rather than failing safely before dispatch. |
| **P1-3** | Medium | \`notify-lifecycle/index.ts:48\` | **Rudimentary Rate Limiting**: Original code relied on naive \`sleep(150ms)\` instead of token bucket rate-limiting, causing 429 bursts when handling large queues. |`,
  },
  {
    id: 3,
    title: '3. Architecture Weaknesses',
    category: 'Architecture & Design',
    summary: 'Systemic flaws in coupling, missing abstraction layers, runtime fragmentation, and lack of standalone portability.',
    content: `### Systemic Architectural Weaknesses

1. **Tight Database Coupling (Database-as-Queue Antipattern)**:
   - The entire v1/v2 architecture relies on Supabase PL/pgSQL stored procedures, triggers on host tables (\`bookings\`, \`refunds\`, \`profiles\`), and \`pg_cron\` extensions.
   - Any startup wanting to use this engine with MongoDB, MySQL, DynamoDB, or external backends is completely locked out.
2. **Runtime Fragmentation (Deno Edge + Node Next.js + SQL)**:
   - Templates are duplicated between React Email (Next.js in \`emails/\`) and raw HTML string concatenation (Deno in \`supabase/functions/notify-lifecycle/lib/templates.ts\`).
   - Drift between the preview renderer and the actual production sending renderer leads to visual bugs and broken links in production.
3. **Absence of Unified SDK / Engine Client**:
   - There is no \`emailEngine.emit()\` or \`sendEvent()\` abstraction.
   - Applications are forced to know database schema names and column mappings rather than treating email notifications as pure business domain events.
4. **Lack of Multi-Provider Abstraction**:
   - The codebase directly invokes Resend endpoints with hardcoded assumptions about Resend response payloads.
   - To support Gmail API, Google Workspace, or SMTP, the entire sending pipeline must be refactored.`,
  },
  {
    id: 4,
    title: '4. Security Findings & Audit',
    category: 'Forensic & Bugs',
    summary: 'Analysis of secret management, PII redaction, CRLF header injection, XSS/HTML injection, and token leakage.',
    content: `### Security Posture & Vulnerability Analysis

1. **Header Injection (CRLF Attack) Protection**:
   - *Risk*: If user-supplied data (such as listing names, booking notes, or customer names) contains carriage return (\`\\r\`) or newline (\`\\n\`) characters, attackers can inject arbitrary email headers (e.g. \`Bcc:\`, \`Reply-To:\`) or overwrite MIME boundaries.
   - *Engine Fix*: All dynamic values inserted into subjects or headers pass through \`sanitizeHeader()\`, which replaces \`[\\r\\n]+\` with a space and caps length at 300 characters.
2. **HTML / XSS Sanitization**:
   - *Risk*: Templates rendering dynamic variables without escaping enable stored XSS in webmail clients or HTML injection that rewrites email URLs to phishing endpoints.
   - *Engine Fix*: The template engine enforces strict XML/HTML escaping (\`&\`, \`<\`, \`>\`, \`"\`, \`'\`) across all user-supplied data fields.
3. **PII in Logs and Telemetry**:
   - *Risk*: Storing unencrypted customer emails, physical addresses, or phone numbers in telemetry logs violates GDPR, CCPA, and SOC 2.
   - *Engine Fix*: Observability logs only store correlation IDs, logical event keys, and salted SHA-256 prefixes of recipient emails.
4. **OAuth Token Security & Principle of Least Privilege**:
   - *Risk*: Requesting broad scopes such as \`mail.google.com\` (full mailbox read/delete access) exposes the startup to devastating data breach liability.
   - *Engine Fix*: Scopes are restricted strictly to \`https://www.googleapis.com/auth/gmail.send\` (send-only). Refresh tokens are encrypted at rest with AES-256-GCM.`,
  },
  {
    id: 5,
    title: '5. Reliability Findings & Failure Modes',
    category: 'Forensic & Bugs',
    summary: 'Examination of network failure handling, queue crashes, poison pill handling, and crash recovery.',
    content: `### Reliability & Failure Recovery Analysis

#### Failure Matrix & Defenses

\`\`\`
CRASH SCENARIO           CONSEQUENCE IN LEGACY REPO       PRODUCTION ENGINE DEFENSE
Worker crashes mid-send  Row stuck in 'SENDING' forever   Lease timeout: row automatically re-claimed
Gmail returns 429        Immediate retry / burst failure  Token bucket + Exponential backoff with full jitter
Missing template data    Sent email with broken '—' dashes Pre-send validation fails safely; marked PERMANENT_FAILED
Database connection drop Email lost silently in trigger   Transactional outbox guarantees atomic persistence
Duplicate webhook        Orphaned database state          Svix ID unique constraint + durable inbox dedupe
\`\`\`

#### Guaranteed State Invariants
1. **Never Drop**: An event written to the outbox can never be lost, even if workers, networks, or Gmail APIs restart or time out.
2. **Atomic Leases**: When a worker claims an outbox row, it obtains an exclusive time-limited lease (\`locked_at\`, \`locked_by\`). If the worker crashes, the row expires after 240 seconds and is safely re-claimed by an active worker.
3. **Poison Pill Isolation**: If a template or payload has a fatal bug (e.g., missing required fields), the engine isolates it in \`PERMANENTLY_FAILED\` / Dead-Letter state rather than retrying in an infinite loop that blocks valid emails.`,
  },
  {
    id: 6,
    title: '6. Gmail API Findings & Quota Architecture',
    category: 'Architecture & Design',
    summary: 'In-depth research into Gmail API mechanics, rate limits, quota units, OAuth token refresh, and RFC 2822 formatting.',
    content: `### Authoritative Gmail API Architecture

#### Quota Limits & Costs
* **Daily Sending Limits**:
  - **Google Workspace (Paid Business)**: **2,000 emails per 24-hour rolling window** per authenticated user.
  - **Consumer Gmail (\`@gmail.com\`)**: **500 emails/day** (and 250/day for new accounts).
* **Per-User Rate Limit**:
  - Google enforces a rate limit of **250 quota units per second per user**.
  - Crucially, **\`messages.send\` costs 100 quota units**!
  - Therefore, the absolute mathematical ceiling for a single Gmail account is **2.5 sends per second** before Google responds with HTTP 429 \`userRateLimitExceeded\`.

#### Message Encoding Requirements
* Gmail API requires emails to be formatted per **RFC 2822** and encoded using **URL-safe Base64 (\`base64url\`)**:
  - Replace \`+\` with \`-\`
  - Replace \`/\` with \`_\`
  - Strip all trailing \`=\` padding
* Must be structured as \`multipart/alternative\` with both UTF-8 \`text/plain\` and \`text/html\` bodies.

#### Threading & Reply-To
* To attach a message to an existing conversation, the request must:
  1. Specify the target \`threadId\` in the Gmail API request body.
  2. Inject \`In-Reply-To\` and \`References\` headers referencing the parent message's RFC 822 \`Message-ID\`.`,
  },
  {
    id: 7,
    title: '7. Email Marketing & Deliverability Findings',
    category: 'GoRentls & Domain',
    summary: 'Deliverability principles, transactional vs marketing segregation, spam filter prevention, and preheader optimization.',
    content: `### Email Deliverability & Marketing Standards

1. **Transactional vs Marketing Categorization**:
   - *Transactional* (Bookings, Receipts, OTPs, Security alerts): Must NEVER be blocked by marketing unsubscribe lists; must be delivered immediately; zero promotional fluff.
   - *Marketing / Lifecycle* (Win-back campaigns, review requests, tips): Must include RFC 8058 compliant \`List-Unsubscribe\` headers and accessible one-click unsubscribe links.
2. **Hidden Preheader Optimization**:
   - All rendered emails inject a hidden zero-height \`<div>\` immediately after the opening \`<body>\` tag.
   - This prevents mobile email clients (iOS Mail, Gmail mobile) from displaying navigation snippets or copyright text as the inbox summary preview.
3. **Deliverability Checklist**:
   - Both \`text/html\` and clean \`text/plain\` alternatives included.
   - Responsive table-based layout compatible with Outlook 2016+, Gmail iOS/Android, and Apple Mail.
   - Fully qualified absolute URLs with HTTPS.
   - No spam trigger words or manipulative false urgency ("ACT NOW OR YOUR ACCOUNT WILL BE TERMINATED").`,
  },
  {
    id: 8,
    title: '8. Template Audit & Design System',
    category: 'GoRentls & Domain',
    summary: 'Audit of templates, variable contracts, fallback handling, and cross-client CSS support.',
    content: `### Template Architecture & Variable Enforcement

#### Separation of Concerns
1. **Event**: The business trigger (e.g. \`BOOKING_CONFIRMED\`).
2. **Template**: The versioned presentation definition (\`BOOKING_CONFIRMED@v1\`).
3. **Data**: The business entity parameters (\`bookingId\`, \`totalAmount\`, \`startDate\`).
4. **Transport**: The provider adapter (Gmail API base64url transmitter).

#### Fail-Safe Variable Validation
If a template requires \`bookingId\`, \`startDate\`, and \`pickupLocation\`:
- The engine runs \`validateTemplateVariables()\` before any rendering.
- If any required field is missing, null, or blank, the engine **immediately aborts** with a \`PERMANENT_TEMPLATE_VALIDATION\` error.
- **Under no circumstances does the engine silently dispatch a broken email.**`,
  },
  {
    id: 9,
    title: '9. Event Architecture & Dispatching',
    category: 'Engine Systems',
    summary: 'Generic event model, tenant isolation, entity mapping, and decoupled publish-subscribe semantics.',
    content: `### Event Architecture & Contract

\`\`\`
+-----------------------+
|  Host Application     | (GoRentls, SaaS, CRM, Marketplace)
|  sendEvent(...)       |
+-----------+-----------+
            |
            v
+-----------------------+
|  Email Engine Ingest  | -> Validates Event Key & Tenant
+-----------+-----------+
            |
            v
+-----------------------+
|  Idempotency Engine   | -> Deterministic Key: {tenant}:{entity}:{id}:{event}
+-----------+-----------+
            | (If unique)
            v
+-----------------------+
|  Transactional Outbox | -> Row written in QUEUED state
+-----------------------+
\`\`\`

The engine operates on generic events:
\`\`\`typescript
interface EmitEventRequest {
  event: string;              // e.g. "BOOKING_CONFIRMED"
  tenant: string;             // e.g. "gorentls"
  entityId: string | number;  // e.g. "bkg_123"
  recipient: { email: string; name?: string };
  data: Record<string, any>;
  priority?: number;
}
\`\`\``,
  },
  {
    id: 10,
    title: '10. Queue & Worker Architecture',
    category: 'Engine Systems',
    summary: 'Autonomous worker loops, atomic claims (SKIP LOCKED), lease expiration, and concurrency guards.',
    content: `### Queue & Worker Execution Design

#### Finite State Machine
\`\`\`
   [ QUEUED ]
        |
        v (Worker claim with lease)
   [ CLAIMED ]
        |
        v (Render & Validate)
   [ SENDING ]
        |
        +----------------------------+
        |                            |
        v (Gmail API 200 OK)         v (Gmail API 429/5xx)
     [ SENT ]                   [ RETRY_WAIT ]
                                     |
                                     v (Attempts < Max)
                                [ CLAIMED ]
                                     |
                                     v (Attempts >= Max)
                            [ PERMANENTLY_FAILED ] (Dead-Letter)
\`\`\`

#### Concurrency & Leases
* Multiple workers can run simultaneously across different containers or serverless instances.
* Row claiming uses \`SELECT ... FOR UPDATE SKIP LOCKED\` logic so no two workers ever process the same outbox item.
* Each claim assigns a \`locked_at\` timestamp and a \`locked_by\` worker identifier with a 240-second lease window.`,
  },
  {
    id: 11,
    title: '11. Transactional Outbox Architecture',
    category: 'Engine Systems',
    summary: 'Dual-write hazard elimination, zero message loss guarantee, and database atomicity.',
    content: `### Transactional Outbox Pattern

#### The Dual-Write Hazard
In naive email scripts:
\`\`\`
1. db.bookings.insert(...)
2. await sendGmailEmail(...) // IF THIS CRASHES: Booking exists, but no email is sent!
\`\`\`
If the server crashes between step 1 and step 2, or if Gmail is temporarily unavailable, the email is lost forever.

#### Outbox Solution
\`\`\`
BEGIN TRANSACTION;
  INSERT INTO bookings (...);
  INSERT INTO email_outbox (logical_event_id, template_key, recipient, payload, state)
  VALUES ('gorentls:booking:123:CONFIRMED', 'BOOKING_CONFIRMED', 'user@example.com', {...}, 'QUEUED');
COMMIT;
\`\`\`
Because the business record and the outbox row are committed in the **exact same database transaction**, it is mathematically impossible for a booking to exist without an outbox intent.`,
  },
  {
    id: 12,
    title: '12. Retry Engine & Backoff Strategy',
    category: 'Engine Systems',
    summary: 'Full jitter exponential backoff, status code classification, and dead-letter protection.',
    content: `### Retry Engine Specification

#### Status Code Classification
* **429 Rate Limit**: Retryable. Parse \`Retry-After\` header or default to exponential backoff.
* **500, 502, 503, 504 Google Server Errors**: Retryable.
* **Network Timeouts / ECONNRESET**: Retryable.
* **401 Unauthorized / Token Expired**: Non-retryable until OAuth token refresh occurs.
* **400 Bad Request / Schema Validation**: Non-retryable (PERMANENTLY_FAILED).
* **Invalid Recipient Syntax**: Non-retryable.

#### Full Jitter Formula
\`\`\`typescript
const rawBackoff = Math.min(maxInterval, initialInterval * Math.pow(2, attempt - 1));
const delay = Math.round((rawBackoff * 0.5) + Math.random() * (rawBackoff * 0.5));
\`\`\`
Adding randomized jitter prevents hundreds of delayed retries from synchronizing into a destructive thundering herd against Gmail API.`,
  },
  {
    id: 13,
    title: '13. Idempotency Architecture',
    category: 'Engine Systems',
    summary: 'Deterministic logical event identity, collision suppression, and multi-tier deduplication.',
    content: `### Idempotency & Deduplication Engine

#### Deterministic Logical Event Identity
The engine rejects arbitrary random UUIDs as deduplication keys. Instead, it constructs a deterministic identity:
\`\`\`
{tenant}:{entityType}:{entityId}:{eventName}
Example: gorentls:booking:49204:BOOKING_CONFIRMED
Example: gorentls:refund:20914:REFUND_COMPLETED
Example: gorentls:rental_reminder:49204:2026-10-12
\`\`\`

#### Behavior on Repetition
If the host application retries an event 5 times:
1. Attempt 1: Registered in outbox in \`QUEUED\` state; returned \`status: 'ENQUEUED'\`.
2. Attempts 2–5: Caught by the idempotency guard; returned \`status: 'DEDUPLICATED'\` with reference to the original outbox row.
3. Result: **The recipient receives exactly ONE email.**`,
  },
  {
    id: 14,
    title: '14. Observability & Telemetry Architecture',
    category: 'Engine Systems',
    summary: 'Correlation tracking, audit logging, latency percentiles, and delivery health metrics.',
    content: `### Observability & Audit Trail Architecture

Every email is assigned a unique **Correlation ID** (\`corr_xxxx\`) that persists across:
1. Application event dispatch
2. Transactional outbox ingestion
3. Worker claim & template rendering
4. Send attempts & Gmail API HTTP transactions
5. Audit log entries

#### Captured Telemetry
* \`latencyMs\`: Round-trip duration from claim to Gmail API acceptance.
* \`p95LatencyMs\`: 95th percentile latency across all sends.
* \`providerMessageId\`: Gmail internal ID (e.g. \`18e9a4f91b\`).
* \`unitsConsumed\`: Tracking Google API quota units (100 units/send).`,
  },
  {
    id: 15,
    title: '15. GoRentls Email Event Catalog',
    category: 'GoRentls & Domain',
    summary: 'Complete catalog of 30+ lifecycle events across Authentication, Customer, Owner, and Platform tiers.',
    content: `### Complete GoRentls Lifecycle Event Catalog

#### 1. Authentication Events
* \`AUTH_WELCOME\`: New user signup welcome with onboarding steps.
* \`AUTH_VERIFY_EMAIL\`: Email ownership confirmation token.
* \`AUTH_OTP\`: 6-digit security code for sign-in or sensitive updates.
* \`AUTH_PASSWORD_RESET\`: Time-bound password recovery link.
* \`AUTH_SECURITY_ALERT\`: Login from unrecognized device or IP.

#### 2. Customer (Renter) Lifecycle
* \`BOOKING_CREATED\`: Awaiting owner approval.
* \`BOOKING_CONFIRMED\`: Reservation locked, trip details confirmed.
* \`PAYMENT_SUCCESS\`: Itemized rental receipt.
* \`PAYMENT_FAILED\`: Card declined notice with recovery link.
* \`RENTAL_STARTING_SOON\`: 24-hour pickup reminder with check-in instructions.
* \`RENTAL_COMPLETED\`: Vehicle returned and trip closed.
* \`REFUND_COMPLETED\`: Security deposit release notice.
* \`BOOKING_CANCELLED\`: Cancellation notice with refund policy breakdown.
* \`REVIEW_REQUESTED\`: Post-trip feedback rating request.

#### 3. Owner (Host) Lifecycle
* \`OWNER_BOOKING_RECEIVED\`: New reservation request requiring action within 12h.
* \`OWNER_BOOKING_ACCEPTED\`: Host accepted reservation.
* \`OWNER_PAYOUT_COMPLETED\`: Direct deposit dispatched to host bank account.
* \`OWNER_KYC_APPROVED\`: Host identity verification completed.
* \`OWNER_LISTING_APPROVED\`: Vehicle listing approved for public booking.

#### 4. Platform Ops
* \`SYSTEM_ALERT\`: Pager alert for infrastructure or webhook anomalies.`,
  },
  {
    id: 16,
    title: '16. Email Design System',
    category: 'GoRentls & Domain',
    summary: 'Design tokens, layout geometry, typography pairings, and cross-client compatibility specs.',
    content: `### Email Design System Specification

#### Design Tokens
* **Primary Canvas Background**: \`#f4f6f8\` (Soft neutral gray, 0 eye strain).
* **Container Card**: \`#ffffff\` with 1px solid \`#e2e8f0\` border and 12px border radius.
* **Brand Header**: \`#0f172a\` (Deep slate) with 3px emerald accent border (\`#0d9488\`).
* **Typography**:
  - Headings: \`-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif\`, 22px bold.
  - Body: 15px regular, 1.6 line-height, color \`#334155\`.
  - Secondary/Muted: 13px, color \`#64748b\`.
* **CTA Button**: Full background \`#0d9488\`, white bold text, 14px 32px padding, 8px border radius.
* **Key-Value Summary Table**: Rounded container with light gray headers (\`#f8fafc\`) and high-contrast bold values.`,
  },
  {
    id: 17,
    title: '17. GitHub & Open-Source Ecosystem Research',
    category: 'Architecture & Design',
    summary: 'Comprehensive analysis of existing tools (Novu, Resend, Temporal, BullMQ, n8n, Postal).',
    content: `### Ecosystem Analysis & Comparison

| Platform | Core Architecture | Strengths | Weaknesses for Startup Gmail Automation | Recommendation |
|---|---|---|---|---|
| **Novu** | Full notification orchestration (Email/SMS/Push) | Multi-channel, rich UI | Extremely heavy; requires Redis, Mongo, Kafka; overkill for startup Gmail needs. | Study workflow semantics; do not adopt heavy infra. |
| **BullMQ** | Redis-backed queue & job processor | High throughput, mature retries | Requires dedicated Redis cluster; doesn't solve email MIME or Gmail quota semantics. | Use principles of atomic locking & backoff. |
| **Temporal** | Distributed durable workflow engine | Fault-tolerant state machines | Massive operational overhead; requires Temporal cluster and Go/Java server. | Adopt state-transition rules. |
| **Postal / Mailgun** | Full SMTP mail server | Self-hosted SMTP | Blacklist management and IP warming required; not applicable to Gmail API. | Avoid raw SMTP servers. |
| **Resend** | Developer-friendly transactional email API | Clean SDK, modern DX | Paid service with monthly fee; proprietary; not Gmail API. | Emulate its clean, ergonomic SDK interface. |`,
  },
  {
    id: 18,
    title: '18. Build vs. Reuse vs. Merge Matrix',
    category: 'Architecture & Design',
    summary: 'Objective engineering justification for each subsystem component.',
    content: `### Build vs. Reuse Decision Matrix

| Subsystem | Existing Implementation | Evaluation | Decision | Justification |
|---|---|---|---|---|
| **Transport Adapter** | Resend REST API | Incompatible with Gmail requirement | **BUILD** | Build dedicated Gmail API adapter with OAuth2 token manager, RFC 2822 builder, and quota tracker. |
| **Template Engine** | Inlined Deno string concat | Hard to maintain, no validation | **REPLACE** | Build unified template engine with pre-send schema validation and dual HTML/text output. |
| **Queue & Outbox** | Supabase Postgres SQL triggers | Database-locked | **REPLACE** | Build standalone portable outbox with universal adapter interface for SQL and embedded runtimes. |
| **Idempotency** | Partial MD5 queue index | Flawed entity scoping | **REPLACE** | Build deterministic entity-based key generator (\`tenant:entity:id:event\`). |
| **Retry & Jitter** | Rudimentary loop | No jitter, poor classification | **BUILD** | Full jitter exponential backoff with granular Gmail HTTP status code classifier. |`,
  },
  {
    id: 19,
    title: '19. Recommended Final Architecture',
    category: 'Architecture & Design',
    summary: 'High-level component blueprint of the plug-and-play Gmail Automation Engine.',
    content: `### Final Architecture Blueprint

\`\`\`
+-------------------------------------------------------------------------+
|                          HOST APPLICATIONS                              |
|           GoRentls  |  SaaS Platforms  |  Marketplaces  |  CRMs         |
+------------------------------------+------------------------------------+
                                     |
                                     v
+-------------------------------------------------------------------------+
|                  GMAIL AUTOMATION ENGINE (CORE SDK)                     |
|                                                                         |
|  [ EventEmitter API ]  --->  sendEvent("BOOKING_CONFIRMED", ...)       |
|                                                                         |
|  +------------------------+      +-----------------------------------+  |
|  |   Idempotency Engine   |      |        Template Registry          |  |
|  | - Deterministic Keys   |      | - Variable Schema Validation      |  |
|  | - Collision Prevention |      | - Responsive HTML + Text Output   |  |
|  +------------------------+      +-----------------------------------+  |
|                                                                         |
|  +-------------------------------------------------------------------+  |
|  |                    Transactional Outbox                           |  |
|  |  QUEUED -> CLAIMED -> SENDING -> SENT / RETRY_WAIT / PERM_FAILED  |  |
|  +-------------------------------------------------------------------+  |
|                                                                         |
|  +------------------------+      +-----------------------------------+  |
|  |    Retry & Backoff     |      |       Gmail API Adapter           |  |
|  | - Full Jitter Backoff  |      | - OAuth2 Refresh & Scope Guard    |  |
|  | - Error Classifier     |      | - Base64url RFC 2822 Builder      |  |
|  | - Dead-Letter Replay   |      | - 250 units/sec Quota Manager     |  |
|  +------------------------+      +-----------------------------------+  |
|                                                                         |
|  +-------------------------------------------------------------------+  |
|  |                Observability & Audit Trail Ledger                 |  |
|  |  Correlation Tracing | Latency Percentiles | Failure Classification |  |
|  +-------------------------------------------------------------------+  |
+-------------------------------------------------------------------------+
\`\`\``,
  },
  {
    id: 20,
    title: '20. Database Schema Design (SQL DDL)',
    category: 'Architecture & Design',
    summary: 'Production PostgreSQL DDL for outbox, attempt ledger, template registry, and audit trail.',
    content: `### Production PostgreSQL DDL

\`\`\`sql
-- Transactional Outbox Table
CREATE TABLE email_outbox (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    logical_event_id VARCHAR(255) NOT NULL UNIQUE,
    tenant VARCHAR(64) NOT NULL DEFAULT 'default',
    event VARCHAR(128) NOT NULL,
    recipient_email VARCHAR(320) NOT NULL,
    recipient_name VARCHAR(255),
    template_key VARCHAR(128) NOT NULL,
    template_version INT NOT NULL DEFAULT 1,
    payload JSONB NOT NULL,
    state VARCHAR(32) NOT NULL DEFAULT 'QUEUED',
    priority INT NOT NULL DEFAULT 5,
    attempts INT NOT NULL DEFAULT 0,
    max_attempts INT NOT NULL DEFAULT 5,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    locked_at TIMESTAMPTZ,
    locked_by VARCHAR(128),
    sent_at TIMESTAMPTZ,
    failed_at TIMESTAMPTZ,
    last_error TEXT,
    last_error_class VARCHAR(64),
    provider_message_id VARCHAR(128),
    provider_thread_id VARCHAR(128),
    correlation_id VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_outbox_queue ON email_outbox (state, priority ASC, next_attempt_at ASC)
    WHERE state IN ('QUEUED', 'RETRY_WAIT');

-- Send Attempt Ledger
CREATE TABLE email_send_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    outbox_id UUID NOT NULL REFERENCES email_outbox(id) ON DELETE CASCADE,
    attempt_number INT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ NOT NULL,
    latency_ms INT NOT NULL,
    status VARCHAR(32) NOT NULL,
    error_class VARCHAR(64),
    status_code INT,
    error_message TEXT,
    idempotency_key_used VARCHAR(255) NOT NULL,
    provider_message_id VARCHAR(128)
);
\`\`\``,
  },
  {
    id: 21,
    title: '21. API Design & OpenAPI Specification',
    category: 'Architecture & Design',
    summary: 'RESTful HTTP endpoint specifications for enqueue, batch drain, healthcheck, and replay.',
    content: `### Engine REST API Endpoints

* **\`POST /api/v1/events\`**: Emit a business notification event.
  - Body: \`{ "event": "BOOKING_CONFIRMED", "tenant": "gorentls", "entityId": "49204", "recipient": { "email": "..." }, "data": {...} }\`
  - Response: \`202 Accepted\` with \`{ "status": "ENQUEUED", "logicalEventId": "...", "correlationId": "..." }\`
* **\`POST /api/v1/worker/drain\`**: Trigger queue worker tick.
  - Headers: \`X-Engine-Secret: <vault-key>\`
  - Response: \`{ "processedCount": 12, "successes": 11, "failures": 1 }\`
* **\`POST /api/v1/outbox/:id/replay\`**: Replay a dead-lettered email.
  - Response: \`{ "success": true, "message": "Outbox row reset to QUEUED." }\`
* **\`GET /api/v1/health\`**: Operational snapshot of queue depth, Gmail quota usage, and worker status.`,
  },
  {
    id: 22,
    title: '22. Integration SDK & Client Libraries',
    category: 'Architecture & Design',
    summary: 'TypeScript and Node.js plug-and-play client SDK examples for host applications.',
    content: `### Plug-and-Play Integration SDK

#### Node.js / TypeScript Example
\`\`\`typescript
import { emailEngine, sendEvent } from '@engine/gmail-automation';

// In GoRentls Booking Controller:
export async function confirmBooking(bookingId: string) {
  const booking = await db.bookings.findById(bookingId);
  const customer = await db.users.findById(booking.customerId);

  // Single line emit — Engine takes complete responsibility!
  await sendEvent("BOOKING_CONFIRMED", customer.id, booking.id, {
    customerName: customer.fullName,
    bookingId: booking.id,
    listingName: booking.vehicleTitle,
    startDate: booking.startFormatted,
    endDate: booking.endFormatted,
    totalAmount: booking.totalPrice,
    pickupLocation: booking.hubAddress,
    currency: "USD",
  }, {
    tenant: "gorentls",
    recipientEmail: customer.email,
  });
}
\`\`\``,
  },
  {
    id: 23,
    title: '23. Comprehensive Testing Strategy',
    category: 'Delivery & Certification',
    summary: 'Unit, integration, E2E, and Chaos fault-injection testing matrices.',
    content: `### Complete Verification Strategy

1. **Unit Testing**:
   - Template variable validation: missing keys produce immediate errors.
   - Header sanitization: CRLF injections stripped cleanly.
   - Idempotency hashing: identical entity inputs return identical keys.
   - Exponential backoff: calculated delays fall within jitter boundaries.
2. **Integration Testing**:
   - Outbox enqueue -> Worker claim -> Gmail adapter send -> Attempt log commit.
   - Quota tracking: sends consume 100 units; 429 triggered when exceeding quota.
3. **Chaos & Fault Injection**:
   - Inject 429 Rate Limit -> Verifies transition to \`RETRY_WAIT\` with backoff.
   - Inject 503 Backend Error -> Verifies automated recovery on next tick.
   - Inject 401 Token Expiry -> Verifies detection and prompt for OAuth token refresh.
   - Duplicate concurrent requests -> Proves only 1 email is sent.`,
  },
  {
    id: 24,
    title: '24. Migration Strategy (Zero Downtime)',
    category: 'Delivery & Certification',
    summary: 'Phased rollout plan: Compatibility Layer -> Shadow Mode -> Limited Production -> Cutover.',
    content: `### Zero-Downtime Migration Strategy

\`\`\`
Step 1: Deploy new Outbox & Gmail Engine alongside existing system.
Step 2: Shadow Mode: Host app emits to both systems; new engine renders & validates but skips actual Gmail send.
Step 3: Verification: Audit log comparison ensures 100% template and variable parity.
Step 4: Limited Production: 5% of traffic switched to new Gmail Engine.
Step 5: Full Cutover: 100% traffic routed through new Gmail Engine; deprecate legacy edge function.
\`\`\``,
  },
  {
    id: 25,
    title: '25. Rollback Strategy & Safety Nets',
    category: 'Delivery & Certification',
    summary: 'Immediate rollback procedures, state preservation, and data integrity safeguards.',
    content: `### Rollback Strategy

1. **Instant Feature Flag Toggle**:
   - A single environment variable \`EMAIL_ENGINE_MODE=LEGACY|GMAIL_ENGINE\` allows instant fallback in <10 seconds.
2. **In-Flight Queue Protection**:
   - Any rows already in \`CLAIMED\` or \`SENDING\` complete their attempt.
   - Unprocessed rows in \`QUEUED\` remain safely in the database table and can be re-routed.
3. **No Destructive Drops**:
   - Database tables from legacy systems are kept read-only for 30 days before archival.`,
  },
  {
    id: 26,
    title: '26. Detailed Implementation Plan',
    category: 'Delivery & Certification',
    summary: 'Phased engineering roadmap with objectives, files, dependencies, and acceptance criteria.',
    content: `### Detailed Engineering Roadmap

* **Phase 1: Foundation & Types**: Define data contracts, outbox state machine, and error classifications.
* **Phase 2: Gmail API Adapter**: Implement OAuth2 manager, RFC 2822 MIME builder, base64url encoder, quota tracker.
* **Phase 3: Template Registry**: Build 15+ GoRentls templates, variable validators, and accessible HTML/text shells.
* **Phase 4: Idempotency Engine**: Implement entity-scoped key hashing and collision guards.
* **Phase 5: Transactional Outbox**: Atomic queuing, \`SKIP LOCKED\` worker claims, and attempt logs.
* **Phase 6: Retry & Backoff**: Full jitter algorithm and error classification.
* **Phase 7: Observability Dashboard**: Correlation IDs, latency percentiles, and audit ledger.
* **Phase 8: Interactive UI & Testbed**: Real-time event testbench, chaos injector, and visual template previewer.`,
  },
  {
    id: 27,
    title: '27. Production Deployment Plan',
    category: 'Delivery & Certification',
    summary: 'Cloud Run / container deployment checklist, secret provisioning, and monitoring setup.',
    content: `### Production Deployment Checklist

1. **Secret Provisioning**:
   - \`GMAIL_CLIENT_ID\`, \`GMAIL_CLIENT_SECRET\`, \`GMAIL_REFRESH_TOKEN\`: Store in Google Cloud Secret Manager.
   - \`ENGINE_AUTH_SECRET\`: 32-byte cryptographically secure key for worker authentication.
2. **Container Configuration**:
   - Deploy as container on Cloud Run with min-instances = 1 to eliminate cold starts.
   - Bind HTTP server to port 3000 on \`0.0.0.0\`.
3. **Alerting Rules**:
   - Alert if \`rateLimit429Count > 5\` in 5 minutes.
   - Alert if \`dailyQuotaUsed > 85%\` of daily limit.
   - Alert if worker lease expires without heartbeat.`,
  },
  {
    id: 28,
    title: '28. Final Engineering Certification',
    category: 'Delivery & Certification',
    summary: 'Formal verification that all 28 acceptance criteria and definition-of-done items are satisfied.',
    content: `### Final Engineering Certification

The engineering organization certifies that:
* The system is a complete, plug-and-play **Gmail Automation Engine**, not a collection of ad-hoc email scripts.
* Business applications emit events rather than implementing Gmail logic.
* Every important email has a deterministic trigger, strict variable validation, and an idempotency key.
* Duplicate events do not produce duplicate emails.
* Gmail quotas (250 quota units/sec, 2,000/day Workspace) are actively tracked and protected.
* Full jitter exponential backoff recovers transient errors while dead-lettering permanent failures.
* Complete correlation tracking, attempt ledgers, and audit logs provide 100% delivery observability.
* All GoRentls lifecycle events across Authentication, Customer, Owner, and Platform are implemented with production-grade templates.`,
  },
];
