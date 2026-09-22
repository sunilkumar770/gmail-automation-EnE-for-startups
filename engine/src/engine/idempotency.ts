export interface IdempotencyRecord {
  key: string;
  logicalEventId: string;
  outboxId: string;
  status: 'PENDING' | 'RESOLVED' | 'FAILED';
  firstSeenAt: string;
  lastAttemptAt: string;
  attemptsSeen: number;
}

export class IdempotencyEngine {
  private cache: Map<string, IdempotencyRecord> = new Map();

  /**
   * Generates a deterministic logical event idempotency key.
   * e.g., gorentls:booking:123:BOOKING_CONFIRMED
   * or gorentls:refund:456:REFUND_COMPLETED
   */
  public generateKey(tenant: string, entityType: string, entityId: string | number, event: string): string {
    const cleanTenant = (tenant || 'default').toLowerCase().trim();
    const cleanEntityType = entityType.toLowerCase().trim();
    const cleanEntityId = String(entityId).trim();
    const cleanEvent = event.toUpperCase().trim();
    return `${cleanTenant}:${cleanEntityType}:${cleanEntityId}:${cleanEvent}`;
  }

  /**
   * Check if this key has already been seen or completed.
   * Returns whether it should be deduplicated (ignored or returned existing result).
   */
  public check(key: string): { isDuplicate: boolean; record?: IdempotencyRecord } {
    const existing = this.cache.get(key);
    if (existing) {
      existing.attemptsSeen += 1;
      existing.lastAttemptAt = new Date().toISOString();
      return { isDuplicate: true, record: existing };
    }
    return { isDuplicate: false };
  }

  /**
   * Register a new key in PENDING state.
   */
  public register(key: string, outboxId: string, logicalEventId: string): IdempotencyRecord {
    const now = new Date().toISOString();
    const record: IdempotencyRecord = {
      key,
      logicalEventId,
      outboxId,
      status: 'PENDING',
      firstSeenAt: now,
      lastAttemptAt: now,
      attemptsSeen: 1,
    };
    this.cache.set(key, record);
    return record;
  }

  /**
   * Mark as RESOLVED once the provider accepts the email.
   */
  public resolve(key: string): void {
    const record = this.cache.get(key);
    if (record) {
      record.status = 'RESOLVED';
    }
  }

  /**
   * Mark as FAILED if terminal failure occurred.
   */
  public fail(key: string): void {
    const record = this.cache.get(key);
    if (record) {
      record.status = 'FAILED';
    }
  }

  public getAll(): IdempotencyRecord[] {
    return Array.from(this.cache.values());
  }

  public clear(): void {
    this.cache.clear();
  }
}

export const idempotencyEngine = new IdempotencyEngine();
