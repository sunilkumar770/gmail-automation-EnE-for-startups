import { EmitEventRequest, OutboxRecord } from '../types.ts';
import { outboxEngine } from './outbox.ts';

export interface SendEventOptions {
  tenant?: string;
  recipientEmail?: string;
  recipientName?: string;
  priority?: number;
  headers?: Record<string, string>;
  idempotencyKey?: string;
}

/**
 * Universal Plug-and-Play Email Automation Engine SDK
 * 
 * Host applications (GoRentls, SaaS, Marketplaces) call this simple interface.
 * The engine handles recipient resolution, template selection, schema validation,
 * deduplication, transactional outbox durability, and Gmail delivery.
 */
export class EmailAutomationEngine {
  /**
   * Primary emit API:
   * 
   * emailEngine.emit({
   *   event: "BOOKING_CONFIRMED",
   *   tenant: "gorentls",
   *   entityId: bookingId,
   *   recipient: { email: customer.email, name: customer.name },
   *   data: { ... }
   * })
   */
  public async emit(request: EmitEventRequest): Promise<{ status: 'ENQUEUED' | 'DEDUPLICATED'; record: OutboxRecord; message: string }> {
    return outboxEngine.enqueue(request);
  }

  /**
   * Concept-level shorthand specified in mission requirements:
   * 
   * sendEvent("BOOKING_CONFIRMED", customerId, bookingId, data, options)
   */
  public async sendEvent(
    event: string,
    customerId: string | number,
    entityId: string | number,
    data: Record<string, any> = {},
    options: SendEventOptions = {}
  ): Promise<{ status: 'ENQUEUED' | 'DEDUPLICATED'; record: OutboxRecord; message: string }> {
    const tenant = options.tenant || 'gorentls';
    const email = options.recipientEmail || (data.recipientEmail as string) || `user_${customerId}@example.com`;
    const name = options.recipientName || (data.customerName as string) || `Customer #${customerId}`;

    return this.emit({
      event,
      tenant,
      entityId,
      recipient: { email, name },
      data,
      priority: options.priority,
      headers: options.headers,
      idempotencyKey: options.idempotencyKey,
    });
  }
}

export const emailEngine = new EmailAutomationEngine();
export const sendEvent = emailEngine.sendEvent.bind(emailEngine);
