// ============================================================================
// LiveOpsConsole.tsx — REAL operations console for the production email system
// ============================================================================
// Unlike the other tabs (in-memory simulation), everything here calls the
// deployed notify-lifecycle edge function: HEALTHCHECK, ENQUEUE, TRACE,
// REPLAY, DRAIN_QUEUE. Connection settings persist in localStorage.
// ============================================================================
import React, { useCallback, useEffect, useState } from 'react';
import {
  Plug, PlugZap, Unplug, HeartPulse, Send, Search, RotateCcw, Play, Loader2, CheckCircle2, XCircle,
} from 'lucide-react';
import {
  ApiResponse, LifecycleApiClient, LiveConnection, loadConnection, makeClient, saveConnection,
} from '../engine/apiClient.ts';
import { LIVE_TEMPLATES, findLiveTemplate } from '../engine/liveCatalog.ts';

const inputCls =
  'w-full bg-slate-950/60 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-teal-500';
const btnPrimary =
  'inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold bg-teal-600 hover:bg-teal-500 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors';
const btnGhost =
  'inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 disabled:opacity-40 transition-colors';

function Card(props: { title: string; icon: React.ReactNode; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-5 shadow-sm">
      <div className="flex items-center justify-between mb-4">
        <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-slate-300">
          {props.icon}
          {props.title}
        </h2>
        {props.right}
      </div>
      {props.children}
    </div>
  );
}

function ResultBadge({ res }: { res: ApiResponse | null }) {
  if (!res) return null;
  const good = res.ok === true;
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full border ${good ? 'bg-teal-950/60 text-teal-300 border-teal-800' : 'bg-rose-950/60 text-rose-300 border-rose-800'}`}>
      {good ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
      HTTP {String(res.http_status ?? '—')} · {String(res.latency_ms ?? 0)}ms{res.ok ? '' : ` · ${String(res.error ?? 'rejected')}`}
    </span>
  );
}

function JsonView({ data }: { data: unknown }) {
  return (
    <pre className="mt-3 text-[11px] leading-relaxed bg-slate-950/80 border border-slate-800 rounded-lg p-3 overflow-auto max-h-72 text-slate-300 whitespace-pre-wrap break-all">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}

export const LiveOpsConsole: React.FC = () => {
  const [conn, setConn] = useState<LiveConnection | null>(() => loadConnection());
  const [client, setClient] = useState<LifecycleApiClient | null>(() => makeClient(loadConnection()));

  // connection form
  const [fnUrl, setFnUrl] = useState(conn?.fnUrl ?? '');
  const [secret, setSecret] = useState(conn?.secret ?? '');
  const [label, setLabel] = useState(conn?.label ?? 'production');
  const [health, setHealth] = useState<ApiResponse | null>(null);
  const [testing, setTesting] = useState(false);

  // enqueue form
  const [templateKey, setTemplateKey] = useState('otp');
  const tpl = findLiveTemplate(templateKey);
  const [recipient, setRecipient] = useState('');
  const [payloadText, setPayloadText] = useState(() => JSON.stringify(findLiveTemplate('otp')?.skeleton ?? {}, null, 2));
  const [priority, setPriority] = useState('');
  const [logicalOverride, setLogicalOverride] = useState('');
  const [enqRes, setEnqRes] = useState<ApiResponse | null>(null);
  const [busyEnq, setBusyEnq] = useState(false);

  // trace form
  const [traceId, setTraceId] = useState('');
  const [traceRes, setTraceRes] = useState<ApiResponse | null>(null);
  const [busyTrace, setBusyTrace] = useState(false);
  const [replayRes, setReplayRes] = useState<ApiResponse | null>(null);

  // drain
  const [drainRes, setDrainRes] = useState<ApiResponse | null>(null);
  const [busyDrain, setBusyDrain] = useState(false);

  useEffect(() => {
    const t = findLiveTemplate(templateKey);
    if (t) setPayloadText(JSON.stringify(t.skeleton, null, 2));
  }, [templateKey]);

  const applyConn = useCallback((c: LiveConnection | null) => {
    saveConnection(c);
    setConn(c);
    setClient(makeClient(c));
    if (!c) { setHealth(null); setEnqRes(null); setTraceRes(null); setDrainRes(null); }
  }, []);

  const testConnection = async () => {
    if (!fnUrl.trim() || !secret.trim()) return;
    setTesting(true);
    const c: LiveConnection = { fnUrl: fnUrl.trim(), secret: secret.trim(), label: label.trim() || undefined };
    const res = await makeClient(c)!.healthcheck();
    setTesting(false);
    if (res.ok) {
      applyConn(c);
      setHealth(res);
    } else {
      setHealth(res); // show the failure; do NOT persist a broken connection
    }
  };

  const refreshHealth = async () => {
    if (!client) return;
    setTesting(true);
    setHealth(await client.healthcheck());
    setTesting(false);
  };

  const doEnqueue = async () => {
    if (!client) return;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(payloadText);
    } catch (e) {
      setEnqRes({ ok: false, error: `payload is not valid JSON: ${(e as Error).message}` });
      return;
    }
    setBusyEnq(true);
    setEnqRes(await client.enqueue({
      template: templateKey,
      recipient: recipient.trim(),
      payload,
      priority: priority.trim() === '' ? undefined : Number(priority),
      logical_event_id: logicalOverride.trim() || undefined,
    }));
    setBusyEnq(false);
  };

  const doTrace = async () => {
    if (!client || !traceId.trim()) return;
    setBusyTrace(true);
    const id = traceId.trim();
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    setTraceRes(await client.trace(isUuid && !id.includes(':') ? { outbox_id: id } : { logical_event_id: id.toUpperCase() }));
    setBusyTrace(false);
  };

  const doReplay = async (outboxId: string) => {
    if (!client) return;
    setReplayRes(await client.replay(outboxId));
  };

  const doDrain = async () => {
    if (!client) return;
    setBusyDrain(true);
    setDrainRes(await client.drain());
    setBusyDrain(false);
  };

  const outbox = (traceRes?.ok ? (traceRes as Record<string, any>).outbox ?? null : null) as Record<string, any> | null;
  const attempts = (traceRes?.ok ? ((traceRes as Record<string, any>).attempts as any[]) ?? [] : []) as Array<Record<string, any>>;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">Live Ops Console</h1>
          <p className="text-sm text-slate-400 mt-1">
            Real calls to the deployed <code className="text-teal-400">notify-lifecycle</code> edge function — the same
            command surface pg_cron and the RUNBOOK use. Demo tabs stay simulated.
          </p>
        </div>
        <span className={`inline-flex items-center gap-2 text-xs font-bold px-3 py-1.5 rounded-full border ${conn ? 'bg-teal-950/60 text-teal-300 border-teal-700' : 'bg-slate-800 text-slate-400 border-slate-700'}`}>
          {conn ? <PlugZap className="h-4 w-4" /> : <Unplug className="h-4 w-4" />}
          {conn ? `LIVE · ${client?.label}` : 'DEMO MODE (not connected)'}
        </span>
      </div>

      {/* ---------------- connection ---------------- */}
      <Card title="Connection" icon={<Plug className="h-4 w-4 text-teal-400" />}
        right={conn ? <button className={btnGhost} onClick={() => applyConn(null)}><Unplug className="h-4 w-4" /> Disconnect</button> : undefined}>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="md:col-span-2">
            <label className="text-xs text-slate-400 mb-1 block">Edge function URL</label>
            <input className={inputCls} placeholder="https://<project-ref>.supabase.co/functions/v1/notify-lifecycle"
              value={fnUrl} onChange={(e) => setFnUrl(e.target.value)} />
          </div>
          <div>
            <label className="text-xs text-slate-400 mb-1 block">Label</label>
            <input className={inputCls} placeholder="production" value={label} onChange={(e) => setLabel(e.target.value)} />
          </div>
          <div className="md:col-span-2">
            <label className="text-xs text-slate-400 mb-1 block">EMAIL_INTERNAL_SECRET (stored in this browser only)</label>
            <input className={inputCls} type="password" placeholder="••••••••" value={secret} onChange={(e) => setSecret(e.target.value)} />
          </div>
          <div className="flex items-end gap-2">
            <button className={btnPrimary} onClick={testConnection} disabled={testing || !fnUrl.trim() || !secret.trim()}>
              {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <HeartPulse className="h-4 w-4" />}
              Save & Test (HEALTHCHECK)
            </button>
          </div>
        </div>
        {health && (
          <div className="mt-3">
            <ResultBadge res={health} />
            {health.ok && (
              <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                {(['queue_depth', 'daily_sent', 'daily_soft_cap', 'daily_hard_cap', 'drain_lease_owner', 'inbox_backlog'] as const).map((k) =>
                  health[k] !== undefined ? (
                    <div key={k} className="bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2">
                      <div className="text-slate-500">{k}</div>
                      <div className="text-slate-200 font-semibold break-all">{String(health[k])}</div>
                    </div>
                  ) : null)}
                <button className={btnGhost + ' justify-center'} onClick={refreshHealth}>Refresh snapshot</button>
              </div>
            )}
            {!health.ok && <JsonView data={health} />}
          </div>
        )}
      </Card>

      {/* ---------------- enqueue ---------------- */}
      <Card title="Enqueue (schema-validated)" icon={<Send className="h-4 w-4 text-teal-400" />}>
        {!conn ? (
          <p className="text-sm text-slate-500">Connect above to enqueue against the real outbox.</p>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <label className="text-xs text-slate-400 mb-1 block">Template ({LIVE_TEMPLATES.length} registered)</label>
                <select className={inputCls} value={templateKey} onChange={(e) => setTemplateKey(e.target.value)}>
                  {['transactional', 'marketing'].map((cat) => (
                    <optgroup key={cat} label={cat}>
                      {LIVE_TEMPLATES.filter((t) => t.category === cat).map((t) => (
                        <option key={t.key} value={t.key}>{t.key} — {t.name}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-slate-400 mb-1 block">Recipient</label>
                <input className={inputCls} placeholder="renter@gorentls.com" value={recipient} onChange={(e) => setRecipient(e.target.value)} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">Priority (opt.)</label>
                  <input className={inputCls} placeholder="auto" value={priority} onChange={(e) => setPriority(e.target.value.replace(/\D/g, ''))} />
                </div>
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">Logical id (opt.)</label>
                  <input className={inputCls} placeholder="derived" value={logicalOverride} onChange={(e) => setLogicalOverride(e.target.value)} />
                </div>
              </div>
            </div>
            {tpl && (
              <p className="text-[11px] text-slate-500">
                idempotency: <code className="text-slate-400">{tpl.logicalId}</code>
                {tpl.notes ? <> · {tpl.notes}</> : null}
              </p>
            )}
            <div>
              <label className="text-xs text-slate-400 mb-1 block">Payload (JSON — validated by Zod on the worker before enqueue)</label>
              <textarea className={inputCls + ' font-mono text-xs'} rows={10} value={payloadText} onChange={(e) => setPayloadText(e.target.value)} />
            </div>
            <div className="flex items-center gap-3">
              <button className={btnPrimary} onClick={doEnqueue} disabled={busyEnq || !recipient.trim()}>
                {busyEnq ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} ENQUEUE
              </button>
              <ResultBadge res={enqRes} />
              {enqRes?.ok && (
                <button className={btnGhost} onClick={() => { setTraceId(String(enqRes.logical_event_id ?? '')); void doTrace(); }}>
                  <Search className="h-4 w-4" /> Trace it
                </button>
              )}
            </div>
            {enqRes && <JsonView data={enqRes} />}
          </div>
        )}
      </Card>

      {/* ---------------- trace + replay ---------------- */}
      <Card title="Trace / Replay (correlation chain)" icon={<Search className="h-4 w-4 text-teal-400" />}>
        {!conn ? (
          <p className="text-sm text-slate-500">Connect above to trace real outbox rows.</p>
        ) : (
          <div className="space-y-3">
            <div className="flex gap-2">
              <input className={inputCls} placeholder="logical_event_id (e.g. OTP:USER@X:CHAL-1) or outbox uuid"
                value={traceId} onChange={(e) => setTraceId(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void doTrace(); }} />
              <button className={btnPrimary} onClick={doTrace} disabled={busyTrace || !traceId.trim()}>
                {busyTrace ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} TRACE
              </button>
            </div>
            {traceRes && !traceRes.ok && <><ResultBadge res={traceRes} /><JsonView data={traceRes} /></>}
            {outbox && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-bold text-white">{String(outbox.template_key)}@v{String(outbox.template_version)}</span>
                  <span className="px-2 py-0.5 rounded-full bg-slate-800 border border-slate-700 text-teal-300 font-semibold">{String(outbox.state)}</span>
                  <span className="text-slate-400">to {String(outbox.recipient).replace(/^(..).*(@.*)$/, '$1***$2')}</span>
                  <span className="text-slate-500">attempts {String(outbox.attempts)}/{String(outbox.max_attempts)}</span>
                  {['DEAD', 'FAILED', 'BOUNCED', 'SUPPRESSED'].includes(String(outbox.state)) && (
                    <button className={btnGhost + ' ml-auto'} onClick={() => doReplay(String(outbox.id))}>
                      <RotateCcw className="h-4 w-4" /> REPLAY (operator)
                    </button>
                  )}
                </div>
                {replayRes && <ResultBadge res={replayRes} />}
                {attempts.length > 0 && (
                  <table className="w-full text-[11px] text-slate-300">
                    <thead><tr className="text-left text-slate-500 border-b border-slate-800">
                      <th className="py-1 pr-2">#</th><th className="py-1 pr-2">status</th><th className="py-1 pr-2">error class</th>
                      <th className="py-1 pr-2">provider id</th><th className="py-1">finished</th>
                    </tr></thead>
                    <tbody>
                      {attempts.map((a) => (
                        <tr key={String(a.id)} className="border-b border-slate-800/60">
                          <td className="py-1 pr-2">{String(a.attempt_number)}</td>
                          <td className="py-1 pr-2 font-semibold">{String(a.status)}</td>
                          <td className="py-1 pr-2">{String(a.error_class ?? '—')}</td>
                          <td className="py-1 pr-2 break-all">{String(a.provider_email_id ?? '—')}</td>
                          <td className="py-1">{String(a.request_finished_at ?? '—')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <JsonView data={traceRes} />
              </div>
            )}
          </div>
        )}
      </Card>

      {/* ---------------- drain ---------------- */}
      <Card title="Manual drain (catch-up flush)" icon={<Play className="h-4 w-4 text-teal-400" />}
        right={conn ? (
          <button className={btnPrimary} onClick={doDrain} disabled={busyDrain}>
            {busyDrain ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} DRAIN_QUEUE
          </button>
        ) : undefined}>
        <p className="text-xs text-slate-500">
          Normally unnecessary: pg_cron drains every 5 minutes and priority-1 rows (OTP, KYC, refunds…) get an
          immediate fastlane kick on insert. Use this for backlog catch-up per RUNBOOK §2.
        </p>
        {drainRes && <><div className="mt-2"><ResultBadge res={drainRes} /></div><JsonView data={drainRes} /></>}
      </Card>
    </div>
  );
};

export default LiveOpsConsole;
