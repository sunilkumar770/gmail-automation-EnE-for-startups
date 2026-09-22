import React, { useState, useEffect } from 'react';
import { RefreshCw, Play, RotateCcw, Clock, CheckCircle2, AlertCircle, FileText, ChevronRight, Eye } from 'lucide-react';
import { outboxEngine } from '../engine/outbox.ts';
import { OutboxRecord, SendAttemptLog } from '../types.ts';

interface OutboxMonitorProps {
  onRefresh: () => void;
  onDrainWorker: () => void;
  isDraining: boolean;
}

export const OutboxMonitor: React.FC<OutboxMonitorProps> = ({
  onRefresh,
  onDrainWorker,
  isDraining,
}) => {
  const [rows, setRows] = useState<OutboxRecord[]>([]);
  const [autoDrain, setAutoDrain] = useState(false);
  const [selectedRow, setSelectedRow] = useState<OutboxRecord | null>(null);
  const [attempts, setAttempts] = useState<SendAttemptLog[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>('ALL');

  const refreshData = () => {
    setRows(outboxEngine.getRows());
    if (selectedRow) {
      setAttempts(outboxEngine.getAttemptLogs(selectedRow.id));
    }
    onRefresh();
  };

  useEffect(() => {
    refreshData();
  }, []);

  // Auto-drain simulation loop
  useEffect(() => {
    let interval: any = null;
    if (autoDrain) {
      interval = setInterval(async () => {
        await onDrainWorker();
        refreshData();
      }, 3000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [autoDrain, onDrainWorker]);

  const handleSelectRow = (row: OutboxRecord) => {
    setSelectedRow(row);
    setAttempts(outboxEngine.getAttemptLogs(row.id));
  };

  const handleReplay = (rowId: string) => {
    const res = outboxEngine.replayRow(rowId);
    if (res.success) {
      refreshData();
    } else {
      alert(res.message);
    }
  };

  const filteredRows = rows.filter((row) => {
    if (statusFilter === 'ALL') return true;
    if (statusFilter === 'PENDING') return row.state === 'QUEUED' || row.state === 'RETRY_WAIT' || row.state === 'CLAIMED' || row.state === 'SENDING';
    if (statusFilter === 'SENT') return row.state === 'SENT';
    if (statusFilter === 'FAILED') return row.state === 'PERMANENTLY_FAILED' || row.state === 'FAILED';
    return true;
  });

  const getStatusBadge = (state: OutboxRecord['state']) => {
    switch (state) {
      case 'QUEUED':
        return <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300 border border-amber-300 dark:border-amber-700">QUEUED</span>;
      case 'CLAIMED':
        return <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300 border border-blue-300 dark:border-blue-700">CLAIMED</span>;
      case 'SENDING':
        return <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-purple-100 text-purple-800 dark:bg-purple-950/60 dark:text-purple-300 border border-purple-300 dark:border-purple-700 animate-pulse">SENDING</span>;
      case 'SENT':
        return <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-teal-100 text-teal-800 dark:bg-teal-950/60 dark:text-teal-300 border border-teal-300 dark:border-teal-700">SENT</span>;
      case 'RETRY_WAIT':
        return <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-orange-100 text-orange-800 dark:bg-orange-950/60 dark:text-orange-300 border border-orange-300 dark:border-orange-700">RETRY_WAIT</span>;
      case 'PERMANENTLY_FAILED':
        return <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300 border border-rose-300 dark:border-rose-700">DEAD_LETTER</span>;
      default:
        return <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-300">{state}</span>;
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Controls */}
      <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-5 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <span className="text-xs font-semibold uppercase tracking-wider text-teal-600 dark:text-teal-400">
              Durable Asynchronous Ledger
            </span>
            <h2 className="text-xl font-bold text-slate-900 dark:text-white mt-0.5">
              Transactional Outbox & Worker
            </h2>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
              Guarantees zero message loss. Events are stored atomically with business state and claimed exclusively using SKIP LOCKED concurrency leases.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            {/* Auto-drain toggle */}
            <label className="flex items-center space-x-2 bg-slate-100 dark:bg-slate-800 px-3 py-2 rounded-lg text-xs font-medium cursor-pointer border border-slate-200 dark:border-slate-700">
              <input
                type="checkbox"
                checked={autoDrain}
                onChange={(e) => setAutoDrain(e.target.checked)}
                className="rounded text-teal-600 focus:ring-teal-500"
              />
              <span className="text-slate-700 dark:text-slate-300">Auto-Worker Daemon</span>
            </label>

            <button
              onClick={async () => {
                await onDrainWorker();
                refreshData();
              }}
              disabled={isDraining}
              className="flex items-center space-x-1.5 bg-teal-600 hover:bg-teal-500 disabled:opacity-50 text-white text-xs font-semibold px-3.5 py-2 rounded-lg transition-all"
            >
              <Play className="h-3.5 w-3.5 fill-white" />
              <span>{isDraining ? 'Worker Running...' : 'Execute Worker Tick'}</span>
            </button>

            <button
              onClick={refreshData}
              className="p-2 text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
              title="Refresh table"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Filter Pills */}
        <div className="flex items-center space-x-2 mt-4 pt-4 border-t border-slate-100 dark:border-slate-800">
          {['ALL', 'PENDING', 'SENT', 'FAILED'].map((f) => (
            <button
              key={f}
              onClick={() => setStatusFilter(f)}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                statusFilter === f
                  ? 'bg-slate-900 text-white dark:bg-teal-600'
                  : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'
              }`}
            >
              {f} ({
                f === 'ALL'
                  ? rows.length
                  : f === 'PENDING'
                  ? rows.filter((r) => ['QUEUED', 'CLAIMED', 'SENDING', 'RETRY_WAIT'].includes(r.state)).length
                  : f === 'SENT'
                  ? rows.filter((r) => r.state === 'SENT').length
                  : rows.filter((r) => r.state === 'PERMANENTLY_FAILED').length
              })
            </button>
          ))}
        </div>
      </div>

      {/* Main Table + Detail View */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden">
          <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Outbox Rows ({filteredRows.length})
            </h3>
            <span className="text-xs text-slate-400">Click row to inspect attempt ledger</span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 dark:bg-slate-800/50 text-slate-500 dark:text-slate-400 font-semibold border-b border-slate-200 dark:border-slate-800">
                <tr>
                  <th className="p-3">Status</th>
                  <th className="p-3">Logical Event ID</th>
                  <th className="p-3">Recipient</th>
                  <th className="p-3">Template</th>
                  <th className="p-3">Attempts</th>
                  <th className="p-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {filteredRows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="p-8 text-center text-slate-400">
                      No outbox records match this filter. Emit an event from the Ingestion Testbench!
                    </td>
                  </tr>
                ) : (
                  filteredRows.map((row) => {
                    const isSelected = selectedRow?.id === row.id;
                    return (
                      <tr
                        key={row.id}
                        onClick={() => handleSelectRow(row)}
                        className={`cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/60 transition-colors ${
                          isSelected ? 'bg-teal-50/50 dark:bg-teal-950/20' : ''
                        }`}
                      >
                        <td className="p-3 whitespace-nowrap">{getStatusBadge(row.state)}</td>
                        <td className="p-3 font-mono text-slate-900 dark:text-white font-medium max-w-[200px] truncate" title={row.logicalEventId}>
                          {row.logicalEventId}
                        </td>
                        <td className="p-3 text-slate-600 dark:text-slate-300">
                          {row.recipient.email}
                        </td>
                        <td className="p-3 font-mono text-teal-600 dark:text-teal-400">
                          {row.templateKey}@v{row.templateVersion}
                        </td>
                        <td className="p-3 whitespace-nowrap">
                          <span className={`font-semibold ${row.attempts > 1 ? 'text-amber-500' : 'text-slate-600 dark:text-slate-400'}`}>
                            {row.attempts} / {row.maxAttempts}
                          </span>
                          {row.retryCount > 0 && (
                            <span className="ml-1 text-[10px] text-orange-500">({row.retryCount} retries)</span>
                          )}
                        </td>
                        <td className="p-3 text-right whitespace-nowrap">
                          {row.state === 'PERMANENTLY_FAILED' && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleReplay(row.id);
                              }}
                              className="inline-flex items-center space-x-1 px-2.5 py-1 rounded bg-amber-500 hover:bg-amber-600 text-white text-[11px] font-semibold transition-colors"
                              title="Requeue this dead-lettered item"
                            >
                              <RotateCcw className="h-3 w-3" />
                              <span>Replay</span>
                            </button>
                          )}
                          {row.state === 'SENT' && (
                            <span className="text-teal-600 dark:text-teal-400 text-xs flex items-center justify-end space-x-1">
                              <CheckCircle2 className="h-3.5 w-3.5" />
                              <span>Delivered</span>
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Attempt Ledger Detail Panel */}
        <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-5 shadow-sm space-y-4">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            Row Inspector & Attempt Ledger
          </h3>

          {selectedRow ? (
            <div className="space-y-4 text-xs">
              <div className="p-3 bg-slate-50 dark:bg-slate-800/60 rounded-lg space-y-1.5 border border-slate-200 dark:border-slate-700/60">
                <div className="flex justify-between">
                  <span className="text-slate-500">Outbox ID:</span>
                  <span className="font-mono font-medium text-slate-900 dark:text-white">{selectedRow.id}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Correlation ID:</span>
                  <span className="font-mono text-teal-600 dark:text-teal-400">{selectedRow.correlationId}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">State:</span>
                  <div>{getStatusBadge(selectedRow.state)}</div>
                </div>
                {selectedRow.providerMessageId && (
                  <div className="flex justify-between">
                    <span className="text-slate-500">Gmail Message ID:</span>
                    <span className="font-mono text-slate-900 dark:text-white">{selectedRow.providerMessageId}</span>
                  </div>
                )}
                {selectedRow.lastError && (
                  <div className="pt-2 border-t border-slate-200 dark:border-slate-700">
                    <span className="text-rose-500 font-semibold block mb-0.5">Last Error:</span>
                    <p className="text-rose-600 dark:text-rose-400 font-mono text-[11px] break-words">
                      {selectedRow.lastError}
                    </p>
                    <span className="text-[10px] text-slate-400">Class: {selectedRow.lastErrorClass}</span>
                  </div>
                )}
              </div>

              {/* Attempt History */}
              <div>
                <h4 className="font-semibold text-slate-700 dark:text-slate-300 mb-2">
                  Delivery Attempts ({attempts.length})
                </h4>
                <div className="space-y-2">
                  {attempts.length === 0 ? (
                    <p className="text-slate-400 italic">No send attempts yet. Row is awaiting worker drain.</p>
                  ) : (
                    attempts.map((att) => (
                      <div
                        key={att.id}
                        className={`p-2.5 rounded-lg border text-[11px] ${
                          att.status === 'SUCCESS'
                            ? 'bg-teal-50 dark:bg-teal-950/30 border-teal-200 dark:border-teal-800'
                            : 'bg-rose-50 dark:bg-rose-950/30 border-rose-200 dark:border-rose-800'
                        }`}
                      >
                        <div className="flex items-center justify-between font-semibold mb-1">
                          <span>Attempt #{att.attemptNumber}</span>
                          <span className="font-mono">{att.latencyMs}ms</span>
                        </div>
                        <div className="text-slate-600 dark:text-slate-300 text-[10px]">
                          Timestamp: {new Date(att.completedAt).toLocaleTimeString()}
                        </div>
                        {att.status === 'FAILURE' && (
                          <div className="text-rose-600 dark:text-rose-400 font-mono text-[10px] mt-1 break-words">
                            [{att.errorClass}] {att.errorMessage}
                          </div>
                        )}
                        {att.providerMessageId && (
                          <div className="text-teal-700 dark:text-teal-300 font-mono text-[10px] mt-1">
                            Gmail ID: {att.providerMessageId}
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* Raw Payload Preview */}
              <div>
                <h4 className="font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Staged Payload
                </h4>
                <pre className="p-2.5 bg-slate-950 text-slate-200 rounded-lg text-[10px] font-mono overflow-x-auto max-h-40">
                  {JSON.stringify(selectedRow.payload, null, 2)}
                </pre>
              </div>
            </div>
          ) : (
            <div className="text-center py-12 text-slate-400">
              <Eye className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p>Select any outbox row to view attempt history and diagnostic logs.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
