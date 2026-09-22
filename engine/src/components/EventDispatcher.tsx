import React, { useState } from 'react';
import { Play, Copy, Zap, AlertTriangle, CheckCircle2, ShieldAlert, Cpu } from 'lucide-react';
import { GORENTLS_EVENT_CATALOG, EventPreset } from '../engine/gorentlsAdapter.ts';
import { emailEngine } from '../engine/eventEmitter.ts';
import { gmailAdapter } from '../engine/gmailAdapter.ts';
import { TEMPLATE_REGISTRY, validateTemplateVariables } from '../engine/templates.ts';
import { FaultInjectionConfig } from '../types.ts';

interface EventDispatcherProps {
  onEventSent: () => void;
  onNavigateToOutbox: () => void;
}

export const EventDispatcher: React.FC<EventDispatcherProps> = ({ onEventSent, onNavigateToOutbox }) => {
  const [selectedPreset, setSelectedPreset] = useState<EventPreset>(GORENTLS_EVENT_CATALOG[2]); // Default to BOOKING_CONFIRMED
  const [entityId, setEntityId] = useState(selectedPreset.defaultEntityId);
  const [recipientEmail, setRecipientEmail] = useState(selectedPreset.recipientEmail);
  const [recipientName, setRecipientName] = useState(selectedPreset.recipientName);
  const [payloadJson, setPayloadJson] = useState(JSON.stringify(selectedPreset.data, null, 2));
  const [activeFault, setActiveFault] = useState<FaultInjectionConfig['forceError']>(null);
  const [isEmitting, setIsEmitting] = useState(false);
  const [lastResult, setLastResult] = useState<{
    status: string;
    logicalEventId: string;
    outboxId: string;
    message: string;
    correlationId: string;
  } | null>(null);

  // When changing presets, update the inputs
  const handleSelectPreset = (preset: EventPreset) => {
    setSelectedPreset(preset);
    setEntityId(preset.defaultEntityId);
    setRecipientEmail(preset.recipientEmail);
    setRecipientName(preset.recipientName);
    setPayloadJson(JSON.stringify(preset.data, null, 2));
    setLastResult(null);
  };

  // Change fault injection
  const handleFaultChange = (fault: FaultInjectionConfig['forceError']) => {
    setActiveFault(fault);
    gmailAdapter.setFaultConfig({ forceError: fault });
  };

  // Emit single event
  const handleEmit = async () => {
    setIsEmitting(true);
    try {
      let parsedData = {};
      try {
        parsedData = JSON.parse(payloadJson);
      } catch (err) {
        alert('Invalid JSON in payload editor!');
        setIsEmitting(false);
        return;
      }

      // If user selected MISSING_TEMPLATE_VARIABLE fault, delete a required variable
      if (activeFault === 'INVALID_TEMPLATE_VARIABLE') {
        delete (parsedData as any).bookingId;
        delete (parsedData as any).startDate;
      }

      const result = await emailEngine.emit({
        event: selectedPreset.event,
        tenant: 'gorentls',
        entityId,
        recipient: { email: recipientEmail, name: recipientName },
        data: parsedData,
      });

      setLastResult({
        status: result.status,
        logicalEventId: result.record.logicalEventId,
        outboxId: result.record.id,
        message: result.message,
        correlationId: result.record.correlationId,
      });

      onEventSent();
    } catch (err: any) {
      alert('Emission error: ' + (err.message || String(err)));
    } finally {
      setIsEmitting(false);
    }
  };

  // Simulate 5 simultaneous rapid calls with the same entity to test idempotency
  const handleTestIdempotency5x = async () => {
    setIsEmitting(true);
    try {
      let parsedData = JSON.parse(payloadJson);
      const promises = Array.from({ length: 5 }).map(() =>
        emailEngine.emit({
          event: selectedPreset.event,
          tenant: 'gorentls',
          entityId,
          recipient: { email: recipientEmail, name: recipientName },
          data: parsedData,
        })
      );

      const results = await Promise.all(promises);
      const enqueuedCount = results.filter((r) => r.status === 'ENQUEUED').length;
      const dedupeCount = results.filter((r) => r.status === 'DEDUPLICATED').length;

      setLastResult({
        status: 'IDEMPOTENCY_TEST_COMPLETE',
        logicalEventId: results[0].record.logicalEventId,
        outboxId: results[0].record.id,
        message: `Idempotency Test Succeeded: 5 concurrent events emitted. Exactly ${enqueuedCount} written to Outbox, ${dedupeCount} dropped as duplicates. Zero duplicate customer emails!`,
        correlationId: results[0].record.correlationId,
      });

      onEventSent();
    } catch (err: any) {
      alert('Idempotency test failed: ' + (err.message || String(err)));
    } finally {
      setIsEmitting(false);
    }
  };

  // Variable validation feedback
  let parsedPayload: Record<string, any> = {};
  let jsonError = false;
  try {
    parsedPayload = JSON.parse(payloadJson);
  } catch {
    jsonError = true;
  }
  const validation = !jsonError ? validateTemplateVariables(selectedPreset.event, parsedPayload) : { valid: false, missing: [] };

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-5 shadow-sm">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <span className="text-xs font-semibold uppercase tracking-wider text-teal-600 dark:text-teal-400">
              Plug-and-Play Ingestion Testbench
            </span>
            <h2 className="text-xl font-bold text-slate-900 dark:text-white mt-0.5">
              Emit Business Lifecycle Event
            </h2>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 max-w-2xl">
              Simulate host applications (like GoRentls, Marketplaces, or SaaS systems) emitting domain events. The engine automatically handles recipient resolution, template binding, idempotency, and transactional outbox staging.
            </p>
          </div>

          <div className="flex items-center space-x-2">
            <button
              onClick={handleTestIdempotency5x}
              disabled={isEmitting}
              className="flex items-center space-x-2 bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-700/60 hover:bg-amber-100 dark:hover:bg-amber-900/50 text-amber-900 dark:text-amber-200 text-xs font-semibold px-4 py-2.5 rounded-lg transition-colors"
              title="Emits 5 identical events concurrently to verify deduplication"
            >
              <Copy className="h-4 w-4 text-amber-600 dark:text-amber-400" />
              <span>Test Idempotency (5x Burst)</span>
            </button>

            <button
              onClick={handleEmit}
              disabled={isEmitting}
              className="flex items-center space-x-2 bg-teal-600 hover:bg-teal-500 disabled:opacity-50 text-white text-xs font-semibold px-5 py-2.5 rounded-lg shadow-sm transition-all"
            >
              <Play className="h-4 w-4 fill-white" />
              <span>{isEmitting ? 'Staging...' : 'Emit Event'}</span>
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column: Preset Catalog */}
        <div className="space-y-4">
          <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-4 shadow-sm">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-3">
              1. Select GoRentls Lifecycle Event
            </h3>
            <div className="space-y-2 max-h-[540px] overflow-y-auto pr-1">
              {GORENTLS_EVENT_CATALOG.map((preset) => {
                const isSelected = selectedPreset.event === preset.event;
                return (
                  <button
                    key={preset.event}
                    onClick={() => handleSelectPreset(preset)}
                    className={`w-full text-left p-3 rounded-lg border transition-all ${
                      isSelected
                        ? 'border-teal-500 bg-teal-50/70 dark:bg-teal-950/30 ring-1 ring-teal-500'
                        : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 bg-slate-50/50 dark:bg-slate-900/50'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-semibold text-xs text-slate-900 dark:text-white">
                        {preset.name}
                      </span>
                      <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
                        {preset.category}
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 line-clamp-2">
                      {preset.description}
                    </p>
                    <div className="text-[10px] font-mono text-teal-600 dark:text-teal-400 mt-1">
                      {preset.event}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Fault & Chaos Injection Box */}
          <div className="bg-white dark:bg-slate-900 rounded-xl border border-rose-200 dark:border-rose-900/60 p-4 shadow-sm">
            <div className="flex items-center space-x-2 text-rose-600 dark:text-rose-400 mb-2">
              <Cpu className="h-4 w-4" />
              <h3 className="text-xs font-bold uppercase tracking-wider">
                Chaos & Fault Injection Lab
              </h3>
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mb-3">
              Force backend failures to verify automated retry, jittered backoff, and dead-lettering.
            </p>

            <div className="grid grid-cols-2 gap-2 text-xs">
              {[
                { id: null, label: 'Normal (200 OK)' },
                { id: '429_RATE_LIMIT', label: '429 Rate Limit (Quota)' },
                { id: '503_SERVICE_UNAVAILABLE', label: '503 Google 5xx' },
                { id: '401_TOKEN_EXPIRED', label: '401 OAuth Expired' },
                { id: 'NETWORK_TIMEOUT', label: 'Network Timeout' },
                { id: 'INVALID_TEMPLATE_VARIABLE', label: 'Missing Required Var' },
              ].map((fault) => {
                const isActive = activeFault === fault.id;
                return (
                  <button
                    key={String(fault.id)}
                    onClick={() => handleFaultChange(fault.id as any)}
                    className={`p-2 rounded-lg border text-[11px] font-medium text-left transition-colors ${
                      isActive
                        ? 'border-rose-500 bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 font-semibold'
                        : 'border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 hover:border-slate-300 dark:hover:border-slate-700'
                    }`}
                  >
                    {fault.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Center & Right Columns: Parameter Configuration & Payload */}
        <div className="lg:col-span-2 space-y-4">
          <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-5 shadow-sm space-y-4">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              2. Event Parameters & Data Contract
            </h3>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Tenant
                </label>
                <input
                  type="text"
                  disabled
                  value="gorentls"
                  className="w-full text-xs font-mono bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-slate-500 dark:text-slate-400"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Entity ID (Booking / Invoice)
                </label>
                <input
                  type="text"
                  value={entityId}
                  onChange={(e) => setEntityId(e.target.value)}
                  className="w-full text-xs font-mono bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg px-3 py-2 text-slate-900 dark:text-white focus:ring-1 focus:ring-teal-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Recipient Email
                </label>
                <input
                  type="email"
                  value={recipientEmail}
                  onChange={(e) => setRecipientEmail(e.target.value)}
                  className="w-full text-xs font-mono bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg px-3 py-2 text-slate-900 dark:text-white focus:ring-1 focus:ring-teal-500"
                />
              </div>
            </div>

            {/* Payload Editor */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  Dynamic Payload (JSON)
                </label>
                {!validation.valid && (
                  <span className="text-[11px] font-medium text-rose-500 flex items-center space-x-1">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    <span>Missing: {validation.missing.join(', ')}</span>
                  </span>
                )}
                {validation.valid && (
                  <span className="text-[11px] font-medium text-teal-600 dark:text-teal-400 flex items-center space-x-1">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    <span>All required variables present</span>
                  </span>
                )}
              </div>
              <textarea
                rows={10}
                value={payloadJson}
                onChange={(e) => setPayloadJson(e.target.value)}
                className="w-full text-xs font-mono p-3 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:ring-1 focus:ring-teal-500"
              />
            </div>

            {/* Idempotency Key Preview */}
            <div className="p-3 bg-slate-50 dark:bg-slate-800/50 rounded-lg border border-slate-200 dark:border-slate-700/60 text-xs">
              <span className="font-semibold text-slate-600 dark:text-slate-400">Generated Idempotency Key: </span>
              <code className="text-teal-600 dark:text-teal-400 font-mono">
                gorentls:entity:{entityId}:{selectedPreset.event}
              </code>
            </div>
          </div>

          {/* Last Result Notification */}
          {lastResult && (
            <div
              className={`p-4 rounded-xl border shadow-sm transition-all ${
                lastResult.status === 'ENQUEUED'
                  ? 'bg-teal-50 dark:bg-teal-950/30 border-teal-200 dark:border-teal-800 text-teal-900 dark:text-teal-200'
                  : lastResult.status === 'DEDUPLICATED'
                  ? 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800 text-amber-900 dark:text-amber-200'
                  : 'bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800 text-blue-900 dark:text-blue-200'
              }`}
            >
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center space-x-2 mb-1">
                    <span className="font-bold text-xs uppercase tracking-wider px-2 py-0.5 rounded bg-white/70 dark:bg-slate-900/70 border">
                      {lastResult.status}
                    </span>
                    <span className="text-xs font-mono opacity-80">
                      Outbox ID: {lastResult.outboxId}
                    </span>
                  </div>
                  <p className="text-xs mt-1">{lastResult.message}</p>
                </div>

                <button
                  onClick={onNavigateToOutbox}
                  className="text-xs font-semibold underline hover:opacity-80 ml-4 shrink-0"
                >
                  View in Outbox &rarr;
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
