import { OutboxRecord, SendAttemptLog, EmitEventRequest } from '../types.ts';
import { idempotencyEngine } from './idempotency.ts';
import { TEMPLATE_REGISTRY, renderEmail, validateTemplateVariables } from './templates.ts';
import { gmailAdapter } from './gmailAdapter.ts';
import { retryEngine } from './retryEngine.ts';
import { observabilityEngine } from './observability.ts';

export class OutboxEngine {
  private outboxRows: Map<string, OutboxRecord> = new Map();
  private attemptLogs: SendAttemptLog[] = [];
  private isProcessing = false;

  public getRows(): OutboxRecord[] {
    return Array.from(this.outboxRows.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  public getAttemptLogs(outboxId?: string): SendAttemptLog[] {
    if (!outboxId) return [...this.attemptLogs];
    return this.attemptLogs.filter((a) => a.outboxId === outboxId);
  }

  /**
   * Transactional outbox ingestion.
   * Atomically records event intent, checking idempotency.
   */
  public enqueue(request: EmitEventRequest): { status: 'ENQUEUED' | 'DEDUPLICATED'; record: OutboxRecord; message: string } {
    observabilityEngine.recordEventReceived();

    const tenant = request.tenant || 'gorentls';
    const correlationId = 'corr_' + Math.random().toString(36).substring(2, 10);
    const templateKey = request.event;
    const templateDef = TEMPLATE_REGISTRY[templateKey];

    if (!templateDef) {
      throw new Error(`Unsupported event/template: "${templateKey}". Register template first.`);
    }

    // Generate or use supplied idempotency key
    const logicalEventId = request.idempotencyKey || idempotencyEngine.generateKey(tenant, 'entity', request.entityId, request.event);

    // Idempotency Check
    const idempCheck = idempotencyEngine.check(logicalEventId);
    if (idempCheck.isDuplicate) {
      observabilityEngine.recordDuplicateDeduplicated();
      observabilityEngine.logAudit({
        correlationId,
        logicalEventId,
        event: request.event,
        action: 'DEDUPLICATED',
        details: `Duplicate event suppressed. Seen ${idempCheck.record?.attemptsSeen} time(s). Existing outbox row: ${idempCheck.record?.outboxId}`,
        level: 'warn',
      });

      const existingRow = this.outboxRows.get(idempCheck.record!.outboxId);
      return {
        status: 'DEDUPLICATED',
        record: existingRow!,
        message: `Idempotency guard: duplicate event suppressed. Existing status is ${existingRow?.state || 'RESOLVED'}.`,
      };
    }

    const outboxId = 'out_' + Math.random().toString(36).substring(2, 10);
    const now = new Date().toISOString();

    const newRecord: OutboxRecord = {
      id: outboxId,
      logicalEventId,
      tenant,
      event: request.event,
      recipient: request.recipient,
      templateKey,
      templateVersion: templateDef.version,
      payload: request.data,
      state: 'QUEUED',
      priority: request.priority || 5,
      attempts: 0,
      maxAttempts: 5,
      nextAttemptAt: now,
      lockedAt: null,
      lockedBy: null,
      createdAt: now,
      updatedAt: now,
      correlationId,
      retryCount: 0,
    };

    this.outboxRows.set(outboxId, newRecord);
    idempotencyEngine.register(logicalEventId, outboxId, logicalEventId);

    observabilityEngine.logAudit({
      correlationId,
      logicalEventId,
      event: request.event,
      action: 'ENQUEUED',
      details: `Outbox entry created for recipient ${request.recipient.email} (Template: ${templateKey}@v${templateDef.version})`,
      level: 'info',
    });

    return {
      status: 'ENQUEUED',
      record: newRecord,
      message: `Event accepted into transactional outbox with logical id: ${logicalEventId}`,
    };
  }

  /**
   * Drain worker: claims eligible rows (SKIP LOCKED semantics) and processes them.
   */
  public async drainQueue(workerId = 'worker-1'): Promise<{ processedCount: number; successes: number; failures: number }> {
    if (this.isProcessing) {
      return { processedCount: 0, successes: 0, failures: 0 };
    }

    this.isProcessing = true;
    let processedCount = 0;
    let successes = 0;
    let failures = 0;

    try {
      const now = new Date();
      // Select eligible rows: state in QUEUED, RETRY_WAIT, or CLAIMED with expired lease
      const eligible = Array.from(this.outboxRows.values()).filter((row) => {
        if (row.state === 'QUEUED') return true;
        if (row.state === 'RETRY_WAIT' && new Date(row.nextAttemptAt) <= now) return true;
        return false;
      });

      // Sort by priority (1 is highest) and created date
      eligible.sort((a, b) => a.priority - b.priority || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

      for (const row of eligible) {
        processedCount += 1;
        // Atomic lock (simulating FOR UPDATE SKIP LOCKED)
        row.state = 'CLAIMED';
        row.lockedAt = new Date().toISOString();
        row.lockedBy = workerId;
        row.updatedAt = new Date().toISOString();

        const result = await this.processRow(row, workerId);
        if (result.success) {
          successes += 1;
        } else {
          failures += 1;
        }
      }
    } finally {
      this.isProcessing = false;
    }

    return { processedCount, successes, failures };
  }

  /**
   * Processes a single claimed outbox record.
   */
  private async processRow(row: OutboxRecord, workerId: string): Promise<{ success: boolean; error?: string }> {
    const attemptNumber = row.attempts + 1;
    row.attempts = attemptNumber;
    row.state = 'SENDING';
    row.updatedAt = new Date().toISOString();

    const attemptStartTime = Date.now();
    const attemptId = 'att_' + Math.random().toString(36).substring(2, 10);

    observabilityEngine.logAudit({
      correlationId: row.correlationId,
      logicalEventId: row.logicalEventId,
      event: row.event,
      action: 'SEND_ATTEMPT_STARTED',
      details: `Attempt #${attemptNumber} initiated by ${workerId}`,
      level: 'info',
    });

    try {
      // Step 1: Pre-send Template Variable Validation
      const validation = validateTemplateVariables(row.templateKey, row.payload);
      if (!validation.valid) {
        throw new Error(validation.error);
      }

      // Step 2: Render Template
      const rendered = renderEmail(row.templateKey, row.payload, {
        tenantName: row.tenant === 'gorentls' ? 'GoRentals' : row.tenant.toUpperCase(),
      });

      // Step 3: Dispatch through Gmail API Adapter
      const gmailResult = await gmailAdapter.send({
        to: row.recipient.email,
        toName: row.recipient.name,
        from: gmailAdapter.getConfig().connectedEmail,
        fromName: gmailAdapter.getConfig().senderName,
        replyTo: gmailAdapter.getConfig().replyToEmail,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        headers: rendered.headers,
        idempotencyKey: row.logicalEventId,
      });

      const attemptLatency = Date.now() - attemptStartTime;

      // Update row on Success
      row.state = 'SENT';
      row.sentAt = new Date().toISOString();
      row.providerMessageId = gmailResult.providerMessageId;
      row.providerThreadId = gmailResult.providerThreadId;
      row.lockedAt = null;
      row.lockedBy = null;
      row.updatedAt = new Date().toISOString();

      // Log Send Attempt Ledger
      this.attemptLogs.unshift({
        id: attemptId,
        outboxId: row.id,
        attemptNumber,
        startedAt: new Date(attemptStartTime).toISOString(),
        completedAt: new Date().toISOString(),
        latencyMs: attemptLatency,
        status: 'SUCCESS',
        idempotencyKeyUsed: row.logicalEventId,
        providerMessageId: gmailResult.providerMessageId,
        providerThreadId: gmailResult.providerThreadId,
      });

      idempotencyEngine.resolve(row.logicalEventId);
      observabilityEngine.recordSendSuccess(attemptLatency);

      observabilityEngine.logAudit({
        correlationId: row.correlationId,
        logicalEventId: row.logicalEventId,
        event: row.event,
        action: 'SENT',
        details: `Email sent via Gmail API. Gmail Message ID: ${gmailResult.providerMessageId}, Latency: ${attemptLatency}ms`,
        level: 'info',
      });

      return { success: true };
    } catch (err: any) {
      const attemptLatency = Date.now() - attemptStartTime;
      const classification = retryEngine.classifyError(err);

      row.lastError = err.message || String(err);
      row.lastErrorClass = classification.classification;
      row.updatedAt = new Date().toISOString();

      // Record in attempt ledger
      this.attemptLogs.unshift({
        id: attemptId,
        outboxId: row.id,
        attemptNumber,
        startedAt: new Date(attemptStartTime).toISOString(),
        completedAt: new Date().toISOString(),
        latencyMs: attemptLatency,
        status: 'FAILURE',
        errorClass: classification.classification,
        statusCode: err.status || 500,
        errorMessage: row.lastError,
        idempotencyKeyUsed: row.logicalEventId,
      });

      observabilityEngine.recordSendFailure(classification.classification);

      // Handle Retry vs Dead-Letter
      if (!classification.isRetryable || row.attempts >= row.maxAttempts) {
        row.state = 'PERMANENTLY_FAILED';
        row.failedAt = new Date().toISOString();
        row.lockedAt = null;
        row.lockedBy = null;
        idempotencyEngine.fail(row.logicalEventId);

        observabilityEngine.logAudit({
          correlationId: row.correlationId,
          logicalEventId: row.logicalEventId,
          event: row.event,
          action: 'PERMANENT_FAILURE',
          details: `Dead-lettered: ${row.lastError} (${classification.classification}). Attempts: ${row.attempts}/${row.maxAttempts}`,
          level: 'error',
        });
      } else {
        // Schedule next retry with full jitter
        const delayMs = classification.suggestedRetryAfterMs || retryEngine.calculateNextAttemptDelayMs(row.attempts);
        row.state = 'RETRY_WAIT';
        row.retryCount += 1;
        row.nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
        row.lockedAt = null;
        row.lockedBy = null;
        observabilityEngine.recordRetry();

        observabilityEngine.logAudit({
          correlationId: row.correlationId,
          logicalEventId: row.logicalEventId,
          event: row.event,
          action: 'RETRY_SCHEDULED',
          details: `Transient failure: ${row.lastError}. Scheduled retry #${row.attempts + 1} in ${Math.round(delayMs / 1000)}s`,
          level: 'warn',
        });
      }

      return { success: false, error: row.lastError };
    }
  }

  /**
   * Operator Action: Replay a dead-lettered / permanently failed row.
   */
  public replayRow(outboxId: string): { success: boolean; message: string } {
    const row = this.outboxRows.get(outboxId);
    if (!row) {
      return { success: false, message: `Outbox record "${outboxId}" not found.` };
    }

    if (row.state !== 'PERMANENTLY_FAILED' && row.state !== 'FAILED' && row.state !== 'RETRY_WAIT') {
      return { success: false, message: `Cannot replay row in state "${row.state}". Replay is only permitted for failed rows.` };
    }

    row.state = 'QUEUED';
    row.nextAttemptAt = new Date().toISOString();
    row.lockedAt = null;
    row.lockedBy = null;
    row.attempts = 0;
    row.updatedAt = new Date().toISOString();

    observabilityEngine.logAudit({
      correlationId: row.correlationId,
      logicalEventId: row.logicalEventId,
      event: row.event,
      action: 'OPERATOR_REPLAY',
      details: `Operator manually requeued dead-lettered outbox row ${row.id}`,
      level: 'info',
    });

    return { success: true, message: `Outbox row ${row.id} reset to QUEUED for execution.` };
  }

  /**
   * Retrieve complete correlation trace across outbox, attempts, and audit logs.
   */
  public getTrace(query: string): { outbox?: OutboxRecord; attempts: SendAttemptLog[]; logs: any[] } {
    const cleanQuery = query.trim();
    let outbox = Array.from(this.outboxRows.values()).find(
      (r) => r.id === cleanQuery || r.logicalEventId === cleanQuery || r.correlationId === cleanQuery
    );

    const attempts = outbox ? this.getAttemptLogs(outbox.id) : [];
    const logs = observabilityEngine.getAuditLogs(
      outbox ? { correlationId: outbox.correlationId } : undefined
    );

    return { outbox, attempts, logs };
  }

  public clear(): void {
    this.outboxRows.clear();
    this.attemptLogs = [];
    idempotencyEngine.clear();
  }
}

export const outboxEngine = new OutboxEngine();
