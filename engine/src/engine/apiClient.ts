// ============================================================================
// engine/src/engine/apiClient.ts — REAL client for the notify-lifecycle edge fn
// ============================================================================
// The rest of this dashboard is an in-memory SIMULATION (demo mode). This
// client is the bridge to the production system: it calls the deployed Supabase
// edge function (supabase/functions/notify-lifecycle) over HTTP with the
// shared internal secret, exactly like pg_cron does.
//
// Actions exposed (see RUNBOOK.md §2 for semantics):
//   HEALTHCHECK · ENQUEUE · TRACE · REPLAY · DRAIN_QUEUE
//
// The edge fn already sends CORS headers (access-control-allow-origin: *,
// x-internal-secret allowed), so a browser-hosted console works directly.
// For public internet deployments put this dashboard behind auth — the secret
// grants operator powers (enqueue/replay/drain).
// ============================================================================

export interface LiveConnection {
  /** Full edge-function URL, e.g. https://<project>.supabase.co/functions/v1/notify-lifecycle */
  fnUrl: string;
  /** EMAIL_INTERNAL_SECRET (or its WEBHOOK_SECRET alias) configured in Vault/edge env */
  secret: string;
  /** Optional human label, e.g. "production" / "staging" */
  label?: string;
}

export interface ApiResponse {
  ok: boolean;
  http_status?: number;
  error?: string;
  [k: string]: unknown;
}

const LS_KEY = 'gorentls.liveConnection.v1';

export function loadConnection(): LiveConnection | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LiveConnection;
    if (!parsed?.fnUrl || !parsed?.secret) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveConnection(conn: LiveConnection | null): void {
  try {
    if (conn) localStorage.setItem(LS_KEY, JSON.stringify(conn));
    else localStorage.removeItem(LS_KEY);
  } catch {
    /* private-mode browsers: connection just won't persist */
  }
}

export class LifecycleApiClient {
  constructor(private conn: LiveConnection, private timeoutMs = 20000) {}

  get label(): string {
    return this.conn.label || this.conn.fnUrl.replace(/^https?:\/\//, '').split('/')[0];
  }

  private async call(action: string, body: Record<string, unknown> = {}): Promise<ApiResponse> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    const started = Date.now();
    try {
      const res = await fetch(this.conn.fnUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Secret': this.conn.secret,
          'X-Webhook-Secret': this.conn.secret, // blueprint alias (migration 002 §H)
        },
        body: JSON.stringify({ action, ...body }),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let parsed: ApiResponse;
      try {
        parsed = JSON.parse(text) as ApiResponse;
      } catch {
        parsed = { ok: false, error: `non-JSON response (HTTP ${res.status})`, raw: text.slice(0, 400) };
      }
      return { ...parsed, http_status: res.status, latency_ms: Date.now() - started };
    } catch (e) {
      const err = e as Error;
      return {
        ok: false,
        error: err.name === 'AbortError'
          ? `timeout after ${this.timeoutMs}ms`
          : `network error: ${err.message} (CORS? URL? secret?)`,
        latency_ms: Date.now() - started,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Operational snapshot: queue depth, caps, drain lease, inbox backlog. */
  healthcheck(): Promise<ApiResponse> {
    return this.call('HEALTHCHECK');
  }

  /** Zod-validated enqueue (same gate the worker uses). */
  enqueue(args: {
    template: string;
    recipient: string;
    payload: Record<string, unknown>;
    priority?: number;
    logical_event_id?: string;
  }): Promise<ApiResponse> {
    const body: Record<string, unknown> = {
      template: args.template,
      recipient: args.recipient,
      payload: args.payload,
    };
    if (args.priority != null) body.priority = args.priority;
    if (args.logical_event_id) body.logical_event_id = args.logical_event_id;
    return this.call('ENQUEUE', body);
  }

  /** Full correlation chain: outbox row + audit_log + attempts + provider events. */
  trace(args: { logical_event_id?: string; outbox_id?: string }): Promise<ApiResponse> {
    return this.call('TRACE', args);
  }

  /** Operator replay of a DEAD/FAILED/BOUNCED/SUPPRESSED row (audit preserved). */
  replay(outboxId: string, note = 'operator replay via Live Ops console'): Promise<ApiResponse> {
    return this.call('REPLAY', { outbox_id: outboxId, note });
  }

  /** Manual catch-up flush (normally driven by the every-5-min pg_cron drain + the fastlane kick). */
  drain(): Promise<ApiResponse> {
    return this.call('DRAIN_QUEUE');
  }
}

export function makeClient(conn: LiveConnection | null): LifecycleApiClient | null {
  return conn ? new LifecycleApiClient(conn) : null;
}
