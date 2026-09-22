import React, { useState } from 'react';
import { Activity, Search, ShieldCheck, AlertTriangle, CheckCircle2, Clock, Terminal, Filter } from 'lucide-react';
import { observabilityEngine } from '../engine/observability.ts';
import { outboxEngine } from '../engine/outbox.ts';
import { AuditLogEntry } from '../types.ts';

export const ObservabilityView: React.FC = () => {
  const [searchQuery, setSearchQuery] = useState('');
  const [levelFilter, setLevelFilter] = useState<'ALL' | 'info' | 'warn' | 'error'>('ALL');
  const [traceResult, setTraceResult] = useState<any | null>(null);

  const metrics = observabilityEngine.getMetrics();
  const allLogs = observabilityEngine.getAuditLogs();

  const handleSearchTrace = (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) {
      setTraceResult(null);
      return;
    }
    const trace = outboxEngine.getTrace(searchQuery);
    setTraceResult(trace);
  };

  const filteredLogs = allLogs.filter((log) => {
    if (levelFilter !== 'ALL' && log.level !== levelFilter) return false;
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      log.correlationId.toLowerCase().includes(q) ||
      log.logicalEventId.toLowerCase().includes(q) ||
      log.action.toLowerCase().includes(q) ||
      log.details.toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-6">
      {/* Banner */}
      <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-5 shadow-sm">
        <span className="text-xs font-semibold uppercase tracking-wider text-teal-600 dark:text-teal-400">
          Telemetry & Audit Ledger
        </span>
        <h2 className="text-xl font-bold text-slate-900 dark:text-white mt-0.5">
          Engine Observability & Correlation Tracing
        </h2>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
          Complete end-to-end visibility. Every event carries an immutable correlation ID that ties together event enqueueing, idempotency checks, send attempts, and delivery outcomes.
        </p>
      </div>

      {/* Metrics Row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
        <div className="bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm">
          <span className="text-[11px] font-semibold text-slate-500 uppercase">Received</span>
          <div className="text-xl font-bold text-slate-900 dark:text-white mt-1">
            {metrics.totalEventsReceived}
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm">
          <span className="text-[11px] font-semibold text-teal-600 dark:text-teal-400 uppercase">Delivered</span>
          <div className="text-xl font-bold text-teal-600 dark:text-teal-400 mt-1">
            {metrics.totalEmailsSent}
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm">
          <span className="text-[11px] font-semibold text-amber-500 uppercase">Deduplicated</span>
          <div className="text-xl font-bold text-amber-500 mt-1">
            {metrics.duplicatesDeduplicated}
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm">
          <span className="text-[11px] font-semibold text-orange-500 uppercase">Retries</span>
          <div className="text-xl font-bold text-orange-500 mt-1">
            {metrics.totalRetries}
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm">
          <span className="text-[11px] font-semibold text-rose-500 uppercase">Dead-Letter</span>
          <div className="text-xl font-bold text-rose-500 mt-1">
            {metrics.totalEmailsFailed}
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm">
          <span className="text-[11px] font-semibold text-slate-500 uppercase">Avg Latency</span>
          <div className="text-xl font-bold text-slate-900 dark:text-white mt-1">
            {metrics.averageLatencyMs}ms
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm">
          <span className="text-[11px] font-semibold text-slate-500 uppercase">P95 Latency</span>
          <div className="text-xl font-bold text-slate-900 dark:text-white mt-1">
            {metrics.p95LatencyMs}ms
          </div>
        </div>
      </div>

      {/* Trace Search Bar */}
      <div className="bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm">
        <form onSubmit={handleSearchTrace} className="flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-3 h-4 w-4 text-slate-400" />
            <input
              type="text"
              placeholder="Trace by Correlation ID (corr_...), Logical Event ID (gorentls:entity:...), or Outbox ID..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-4 py-2 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white focus:ring-1 focus:ring-teal-500"
            />
          </div>
          <button
            type="submit"
            className="px-4 py-2 bg-teal-600 hover:bg-teal-500 text-white text-xs font-semibold rounded-lg shadow-sm"
          >
            Trace Correlation Chain
          </button>
        </form>

        {/* Trace Inspector View */}
        {traceResult && (
          <div className="mt-4 p-4 rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 space-y-3">
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-700 pb-2">
              <span className="font-bold text-xs uppercase tracking-wider text-slate-700 dark:text-slate-300">
                Trace Lifecycle Result
              </span>
              <button
                onClick={() => setTraceResult(null)}
                className="text-xs text-slate-400 hover:text-slate-200"
              >
                Clear
              </button>
            </div>

            {traceResult.outbox ? (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                <div>
                  <span className="text-slate-400">Logical Event:</span>
                  <p className="font-mono text-slate-900 dark:text-white font-medium break-all">
                    {traceResult.outbox.logicalEventId}
                  </p>
                </div>
                <div>
                  <span className="text-slate-400">State:</span>
                  <p className="font-bold text-teal-600 dark:text-teal-400">{traceResult.outbox.state}</p>
                </div>
                <div>
                  <span className="text-slate-400">Send Attempts:</span>
                  <p className="font-bold text-slate-800 dark:text-slate-200">
                    {traceResult.attempts.length} logged attempts
                  </p>
                </div>
              </div>
            ) : (
              <p className="text-xs text-slate-500">No matching outbox record found for this identifier.</p>
            )}
          </div>
        )}
      </div>

      {/* Audit Log Table */}
      <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden">
        <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            Immutable Audit Trail ({filteredLogs.length} events)
          </h3>

          {/* Level Filter */}
          <div className="flex space-x-1">
            {(['ALL', 'info', 'warn', 'error'] as const).map((lvl) => (
              <button
                key={lvl}
                onClick={() => setLevelFilter(lvl)}
                className={`px-2.5 py-1 rounded text-xs font-medium uppercase transition-colors ${
                  levelFilter === lvl
                    ? 'bg-slate-900 text-white dark:bg-teal-600'
                    : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400'
                }`}
              >
                {lvl}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto max-h-[500px]">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 dark:bg-slate-800/50 text-slate-500 dark:text-slate-400 font-semibold sticky top-0 border-b border-slate-200 dark:border-slate-800">
              <tr>
                <th className="p-3">Timestamp</th>
                <th className="p-3">Level</th>
                <th className="p-3">Correlation ID</th>
                <th className="p-3">Action</th>
                <th className="p-3">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-mono text-[11px]">
              {filteredLogs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="p-8 text-center text-slate-400 font-sans">
                    No audit records logged yet.
                  </td>
                </tr>
              ) : (
                filteredLogs.map((log) => (
                  <tr key={log.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <td className="p-3 whitespace-nowrap text-slate-500">
                      {new Date(log.timestamp).toLocaleTimeString()}
                    </td>
                    <td className="p-3 whitespace-nowrap">
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                          log.level === 'info'
                            ? 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
                            : log.level === 'warn'
                            ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
                            : 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300'
                        }`}
                      >
                        {log.level.toUpperCase()}
                      </span>
                    </td>
                    <td className="p-3 whitespace-nowrap text-teal-600 dark:text-teal-400">
                      {log.correlationId}
                    </td>
                    <td className="p-3 whitespace-nowrap font-semibold text-slate-900 dark:text-white">
                      {log.action}
                    </td>
                    <td className="p-3 text-slate-600 dark:text-slate-300 font-sans">
                      {log.details}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
