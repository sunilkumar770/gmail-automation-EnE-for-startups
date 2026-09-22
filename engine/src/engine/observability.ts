import { AuditLogEntry, ObservabilityMetrics } from '../types.ts';

export class ObservabilityEngine {
  private auditLogs: AuditLogEntry[] = [];
  private latencies: number[] = [];
  private metrics: ObservabilityMetrics = {
    totalEventsReceived: 0,
    totalEmailsSent: 0,
    totalEmailsFailed: 0,
    totalRetries: 0,
    rateLimit429Count: 0,
    serverError5xxCount: 0,
    validationErrorCount: 0,
    duplicatesDeduplicated: 0,
    averageLatencyMs: 0,
    p95LatencyMs: 0,
    uptimeSeconds: 1,
  };
  private startTime = Date.now();

  public logAudit(entry: Omit<AuditLogEntry, 'id' | 'timestamp'>): AuditLogEntry {
    const fullEntry: AuditLogEntry = {
      id: 'aud_' + Math.random().toString(36).substring(2, 10),
      timestamp: new Date().toISOString(),
      ...entry,
    };
    this.auditLogs.unshift(fullEntry);
    // Keep last 1000 logs in memory
    if (this.auditLogs.length > 1000) {
      this.auditLogs.pop();
    }
    return fullEntry;
  }

  public recordEventReceived(): void {
    this.metrics.totalEventsReceived += 1;
  }

  public recordDuplicateDeduplicated(): void {
    this.metrics.duplicatesDeduplicated += 1;
  }

  public recordSendSuccess(latencyMs: number): void {
    this.metrics.totalEmailsSent += 1;
    this.latencies.push(latencyMs);
    this.recalculateLatencyStats();
  }

  public recordSendFailure(errorClass: string): void {
    this.metrics.totalEmailsFailed += 1;
    if (errorClass === 'RETRYABLE_429_RATE_LIMIT') {
      this.metrics.rateLimit429Count += 1;
    } else if (errorClass === 'RETRYABLE_5XX_SERVER_ERROR') {
      this.metrics.serverError5xxCount += 1;
    } else if (errorClass === 'PERMANENT_TEMPLATE_VALIDATION') {
      this.metrics.validationErrorCount += 1;
    }
  }

  public recordRetry(): void {
    this.metrics.totalRetries += 1;
  }

  private recalculateLatencyStats(): void {
    if (this.latencies.length === 0) return;
    const sum = this.latencies.reduce((a, b) => a + b, 0);
    this.metrics.averageLatencyMs = Math.round(sum / this.latencies.length);

    const sorted = [...this.latencies].sort((a, b) => a - b);
    const p95Idx = Math.floor(sorted.length * 0.95);
    this.metrics.p95LatencyMs = sorted[p95Idx] || sorted[sorted.length - 1];
  }

  public getMetrics(): ObservabilityMetrics {
    this.metrics.uptimeSeconds = Math.max(1, Math.round((Date.now() - this.startTime) / 1000));
    return { ...this.metrics };
  }

  public getAuditLogs(filter?: { correlationId?: string; event?: string; level?: string }): AuditLogEntry[] {
    if (!filter) return this.auditLogs;
    return this.auditLogs.filter((log) => {
      if (filter.correlationId && !log.correlationId.includes(filter.correlationId)) return false;
      if (filter.event && log.event !== filter.event) return false;
      if (filter.level && log.level !== filter.level) return false;
      return true;
    });
  }

  public clear(): void {
    this.auditLogs = [];
    this.latencies = [];
    this.metrics = {
      totalEventsReceived: 0,
      totalEmailsSent: 0,
      totalEmailsFailed: 0,
      totalRetries: 0,
      rateLimit429Count: 0,
      serverError5xxCount: 0,
      validationErrorCount: 0,
      duplicatesDeduplicated: 0,
      averageLatencyMs: 0,
      p95LatencyMs: 0,
      uptimeSeconds: 1,
    };
  }
}

export const observabilityEngine = new ObservabilityEngine();
