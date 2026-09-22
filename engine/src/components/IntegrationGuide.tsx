import React, { useState } from 'react';
import { Terminal, Copy, Check, BookOpen, Layers, Code, Zap } from 'lucide-react';

export const IntegrationGuide: React.FC = () => {
  const [copiedSection, setCopiedSection] = useState<string | null>(null);

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedSection(id);
    setTimeout(() => setCopiedSection(null), 2000);
  };

  const sdkCode = `// 1. Install Gmail Automation Engine SDK
import { emailEngine, sendEvent } from '@engine/gmail-automation';

// 2. In GoRentls Booking Controller:
export async function handleBookingConfirmed(bookingId: string) {
  const booking = await db.bookings.findById(bookingId);
  const renter = await db.users.findById(booking.renterId);

  // One-line event emission with atomic transactional outbox durability:
  await sendEvent("BOOKING_CONFIRMED", renter.id, booking.id, {
    customerName: renter.fullName,
    bookingId: booking.id,
    listingName: booking.vehicleTitle,
    startDate: booking.startFormatted,
    endDate: booking.endFormatted,
    totalAmount: booking.totalPrice,
    depositAmount: booking.securityDeposit,
    pickupLocation: booking.hubAddress,
    currency: "USD",
  }, {
    tenant: "gorentls",
    recipientEmail: renter.email,
  });
}`;

  const restCurlCode = `curl -X POST https://your-engine-host.internal/api/v1/events \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer \${ENGINE_AUTH_SECRET}" \\
  -d '{
    "event": "PAYMENT_SUCCESS",
    "tenant": "gorentls",
    "entityId": "inv_91823",
    "recipient": {
      "email": "david.chen@example.com",
      "name": "David Chen"
    },
    "data": {
      "customerName": "David Chen",
      "invoiceId": "INV-91823",
      "bookingId": "49204",
      "amount": "589.00",
      "currency": "USD",
      "paymentMethod": "Visa ending in •••• 4242",
      "date": "Oct 10, 2026, 09:14 AM UTC"
    }
  }'`;

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-5 shadow-sm">
        <span className="text-xs font-semibold uppercase tracking-wider text-teal-600 dark:text-teal-400">
          Developer Integration Guide
        </span>
        <h2 className="text-xl font-bold text-slate-900 dark:text-white mt-0.5">
          Plug-and-Play Integration Architecture
        </h2>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
          Eliminate ad-hoc email scripts forever. Host applications emit domain events; the engine handles recipient resolution, templates, idempotency, retries, and Gmail delivery.
        </p>
      </div>

      {/* Integration Principles */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="p-4 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm">
          <div className="h-8 w-8 rounded-lg bg-teal-50 dark:bg-teal-950/60 text-teal-600 dark:text-teal-400 flex items-center justify-center mb-2 font-bold">
            1
          </div>
          <h4 className="font-bold text-xs text-slate-900 dark:text-white">Emit Domain Events</h4>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Application code never calls Gmail or renders HTML directly. It emits structured events with deterministic entity IDs.
          </p>
        </div>

        <div className="p-4 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm">
          <div className="h-8 w-8 rounded-lg bg-teal-50 dark:bg-teal-950/60 text-teal-600 dark:text-teal-400 flex items-center justify-center mb-2 font-bold">
            2
          </div>
          <h4 className="font-bold text-xs text-slate-900 dark:text-white">Transactional Safety</h4>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Events are written to the outbox inside the same database transaction as the business entity, eliminating dual-write loss.
          </p>
        </div>

        <div className="p-4 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm">
          <div className="h-8 w-8 rounded-lg bg-teal-50 dark:bg-teal-950/60 text-teal-600 dark:text-teal-400 flex items-center justify-center mb-2 font-bold">
            3
          </div>
          <h4 className="font-bold text-xs text-slate-900 dark:text-white">Autonomous Worker</h4>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Worker daemon drains the outbox asynchronously, respecting Gmail's 250 units/sec limit with full-jitter exponential backoff.
          </p>
        </div>
      </div>

      {/* Code Snippets */}
      <div className="space-y-4">
        {/* Node.js / TS SDK */}
        <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden">
          <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <Code className="h-4 w-4 text-teal-600 dark:text-teal-400" />
              <span className="font-bold text-xs text-slate-900 dark:text-white">
                TypeScript / Node.js Host Integration (e.g. GoRentls)
              </span>
            </div>
            <button
              onClick={() => copyToClipboard(sdkCode, 'sdk')}
              className="flex items-center space-x-1 text-xs text-slate-500 hover:text-slate-900 dark:hover:text-slate-100"
            >
              {copiedSection === 'sdk' ? <Check className="h-3.5 w-3.5 text-teal-500" /> : <Copy className="h-3.5 w-3.5" />}
              <span>{copiedSection === 'sdk' ? 'Copied' : 'Copy'}</span>
            </button>
          </div>
          <pre className="p-4 bg-slate-950 text-slate-200 text-xs font-mono overflow-x-auto">
            {sdkCode}
          </pre>
        </div>

        {/* REST API cURL */}
        <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden">
          <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <Terminal className="h-4 w-4 text-teal-600 dark:text-teal-400" />
              <span className="font-bold text-xs text-slate-900 dark:text-white">
                Universal HTTP REST API Ingestion Endpoint
              </span>
            </div>
            <button
              onClick={() => copyToClipboard(restCurlCode, 'curl')}
              className="flex items-center space-x-1 text-xs text-slate-500 hover:text-slate-900 dark:hover:text-slate-100"
            >
              {copiedSection === 'curl' ? <Check className="h-3.5 w-3.5 text-teal-500" /> : <Copy className="h-3.5 w-3.5" />}
              <span>{copiedSection === 'curl' ? 'Copied' : 'Copy'}</span>
            </button>
          </div>
          <pre className="p-4 bg-slate-950 text-slate-200 text-xs font-mono overflow-x-auto">
            {restCurlCode}
          </pre>
        </div>
      </div>
    </div>
  );
};
