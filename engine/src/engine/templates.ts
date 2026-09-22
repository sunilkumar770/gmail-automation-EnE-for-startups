import { TemplateDefinition } from '../types.ts';

export function escapeHtml(str: unknown): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function sanitizeHeader(str: string): string {
  return str.replace(/[\r\n]+/g, ' ').trim().slice(0, 300);
}

export interface RenderResult {
  subject: string;
  html: string;
  text: string;
  preheader: string;
  headers: Record<string, string>;
}

export const TEMPLATE_REGISTRY: Record<string, TemplateDefinition> = {
  // Authentication
  'AUTH_WELCOME': {
    key: 'AUTH_WELCOME',
    version: 1,
    name: 'Welcome to Platform',
    category: 'authentication',
    description: 'Sent upon user signup and profile initialization.',
    requiredVariables: ['userName'],
    optionalVariables: ['verificationLink', 'companyName'],
    defaultSubject: 'Welcome to {{companyName}}, {{userName}}!',
    preheader: 'Your account is ready. Get started exploring your dashboard today.',
    ctaText: 'Verify & Explore',
    ctaUrlTemplate: 'https://gorentals.example/verify',
  },
  'AUTH_OTP': {
    key: 'AUTH_OTP',
    version: 1,
    name: 'Security One-Time Passcode',
    category: 'authentication',
    description: 'Direct authentication or sensitive action authorization code.',
    requiredVariables: ['userName', 'otpCode', 'expiryMinutes'],
    optionalVariables: ['actionType'],
    defaultSubject: '{{otpCode}} is your verification code',
    preheader: 'Valid for {{expiryMinutes}} minutes. Do not share this code with anyone.',
  },
  'AUTH_PASSWORD_RESET': {
    key: 'AUTH_PASSWORD_RESET',
    version: 1,
    name: 'Password Reset Request',
    category: 'authentication',
    description: 'Time-bound password reset token link.',
    requiredVariables: ['userName', 'resetLink', 'expiryMinutes'],
    optionalVariables: ['ipAddress', 'requestedAt'],
    defaultSubject: 'Reset your password',
    preheader: 'We received a request to reset your password. Click to set a new one.',
    ctaText: 'Reset Password',
    ctaUrlTemplate: '{{resetLink}}',
  },

  // Customer Lifecycle (GoRentls & Marketplaces)
  'BOOKING_CONFIRMED': {
    key: 'BOOKING_CONFIRMED',
    version: 1,
    name: 'Booking Confirmation',
    category: 'customer',
    description: 'Sent to renter when booking and payment are validated.',
    requiredVariables: ['customerName', 'bookingId', 'listingName', 'startDate', 'endDate', 'totalAmount', 'pickupLocation'],
    optionalVariables: ['depositAmount', 'currency', 'ownerName', 'pickupInstructions'],
    defaultSubject: 'Confirmed: Your rental for {{listingName}} (#{{bookingId}})',
    preheader: 'Your booking has been approved and locked in. Here are your trip details.',
    ctaText: 'View Rental Details',
    ctaUrlTemplate: 'https://gorentals.example/bookings/{{bookingId}}',
  },
  'PAYMENT_SUCCESS': {
    key: 'PAYMENT_SUCCESS',
    version: 1,
    name: 'Payment Receipt',
    category: 'customer',
    description: 'Sent immediately when billing transaction completes successfully.',
    requiredVariables: ['customerName', 'invoiceId', 'amount', 'currency', 'paymentMethod', 'date'],
    optionalVariables: ['bookingId', 'downloadReceiptUrl'],
    defaultSubject: 'Receipt for your payment of {{currency}} {{amount}}',
    preheader: 'Your payment was processed successfully. Thank you for your business.',
    ctaText: 'Download Invoice',
    ctaUrlTemplate: 'https://gorentals.example/invoices/{{invoiceId}}',
  },
  'PAYMENT_FAILED': {
    key: 'PAYMENT_FAILED',
    version: 1,
    name: 'Payment Attempt Failed',
    category: 'customer',
    description: 'Actionable notice when card charge or bank transfer fails.',
    requiredVariables: ['customerName', 'amount', 'currency', 'reason', 'retryLink'],
    optionalVariables: ['bookingId', 'paymentMethodLast4'],
    defaultSubject: 'Action Required: Payment of {{currency}} {{amount}} could not be processed',
    preheader: 'Please update your payment method to keep your booking active.',
    ctaText: 'Retry Payment Now',
    ctaUrlTemplate: '{{retryLink}}',
  },
  'RENTAL_STARTING_SOON': {
    key: 'RENTAL_STARTING_SOON',
    version: 1,
    name: 'Upcoming Rental Reminder',
    category: 'customer',
    description: '24-hour reminder before vehicle or property handover.',
    requiredVariables: ['customerName', 'listingName', 'startDate', 'pickupLocation'],
    optionalVariables: ['ownerContact', 'securityPin', 'checklistUrl'],
    defaultSubject: 'Reminder: Your rental of {{listingName}} starts tomorrow',
    preheader: 'Get ready for pickup! Review check-in instructions and required documents.',
    ctaText: 'Check-in Guide',
    ctaUrlTemplate: 'https://gorentals.example/checkin',
  },
  'REFUND_COMPLETED': {
    key: 'REFUND_COMPLETED',
    version: 1,
    name: 'Refund Successfully Processed',
    category: 'customer',
    description: 'Notification that refund or security deposit release completed.',
    requiredVariables: ['customerName', 'refundId', 'amount', 'currency', 'estimatedArrivalDays'],
    optionalVariables: ['bookingId', 'bankAccountLast4'],
    defaultSubject: 'Refund of {{currency}} {{amount}} processed (#{{refundId}})',
    preheader: 'Your refund has been initiated and should arrive in {{estimatedArrivalDays}} business days.',
    ctaText: 'View Refund Status',
    ctaUrlTemplate: 'https://gorentals.example/refunds/{{refundId}}',
  },
  'BOOKING_CANCELLED': {
    key: 'BOOKING_CANCELLED',
    version: 1,
    name: 'Booking Cancellation Notice',
    category: 'customer',
    description: 'Formal confirmation that a reservation was cancelled.',
    requiredVariables: ['customerName', 'bookingId', 'listingName', 'cancellationReason', 'refundStatus'],
    optionalVariables: ['refundAmount', 'currency'],
    defaultSubject: 'Booking #{{bookingId}} has been cancelled',
    preheader: 'Your reservation for {{listingName}} is cancelled. Review refund summary.',
    ctaText: 'Review Cancellation Details',
    ctaUrlTemplate: 'https://gorentals.example/bookings/{{bookingId}}',
  },
  'REVIEW_REQUESTED': {
    key: 'REVIEW_REQUESTED',
    version: 1,
    name: 'Trip Feedback & Rating Request',
    category: 'customer',
    description: 'Sent 2 hours after rental completion.',
    requiredVariables: ['customerName', 'listingName', 'bookingId', 'reviewUrl'],
    optionalVariables: ['ownerName'],
    defaultSubject: 'How was your experience with {{listingName}}?',
    preheader: 'Share your feedback to help the community and support your host.',
    ctaText: 'Leave a Review',
    ctaUrlTemplate: '{{reviewUrl}}',
  },

  // Owner / Host Lifecycle
  'OWNER_BOOKING_RECEIVED': {
    key: 'OWNER_BOOKING_RECEIVED',
    version: 1,
    name: 'New Booking Request for Owner',
    category: 'owner',
    description: 'Alerts host of an incoming reservation needing action.',
    requiredVariables: ['ownerName', 'renterName', 'listingName', 'startDate', 'endDate', 'payoutAmount', 'actionDeadline'],
    optionalVariables: ['bookingId', 'renterVerificationBadge'],
    defaultSubject: 'Action Needed: New booking request from {{renterName}}',
    preheader: 'Respond within {{actionDeadline}} to accept or decline this reservation.',
    ctaText: 'Respond to Booking',
    ctaUrlTemplate: 'https://gorentals.example/owner/requests',
  },
  'OWNER_PAYOUT_COMPLETED': {
    key: 'OWNER_PAYOUT_COMPLETED',
    version: 1,
    name: 'Host Earnings Payout Dispatched',
    category: 'owner',
    description: 'Receipt when rental proceeds are transferred to owner account.',
    requiredVariables: ['ownerName', 'payoutId', 'amount', 'currency', 'bankAccountLast4', 'payoutDate'],
    optionalVariables: ['bookingId', 'netPlatformFee'],
    defaultSubject: 'Payout dispatched: {{currency}} {{amount}} sent to your bank',
    preheader: 'Your earnings for booking #{{bookingId}} have been deposited.',
    ctaText: 'View Earnings Breakdown',
    ctaUrlTemplate: 'https://gorentals.example/owner/payouts/{{payoutId}}',
  },

  // Platform & Operational Alerts
  'SYSTEM_ALERT': {
    key: 'SYSTEM_ALERT',
    version: 1,
    name: 'Platform Operations Alert',
    category: 'platform',
    description: 'Internal engineer or administrator system alert.',
    requiredVariables: ['incidentId', 'severity', 'serviceName', 'summary', 'timestamp'],
    optionalVariables: ['traceId', 'runbookUrl'],
    defaultSubject: '[{{severity}}] {{serviceName}}: {{summary}}',
    preheader: 'Automated platform alert. Immediate attention required if High/Critical.',
    ctaText: 'Open Incident Dashboard',
    ctaUrlTemplate: 'https://gorentals.example/ops/incidents/{{incidentId}}',
  },
};

/**
 * Validate that all required variables are present and non-empty.
 * Prevents sending broken emails with missing {{placeholders}}!
 */
export function validateTemplateVariables(
  templateKey: string,
  data: Record<string, any>
): { valid: boolean; missing: string[]; error?: string } {
  const def = TEMPLATE_REGISTRY[templateKey];
  if (!def) {
    return { valid: false, missing: [], error: `Template key "${templateKey}" is not registered.` };
  }

  const missing: string[] = [];
  for (const requiredVar of def.requiredVariables) {
    const val = data[requiredVar];
    if (val === undefined || val === null || val === '') {
      missing.push(requiredVar);
    }
  }

  if (missing.length > 0) {
    return {
      valid: false,
      missing,
      error: `Validation failed for template "${templateKey}": Missing required variable(s): ${missing.join(', ')}`,
    };
  }

  return { valid: true, missing: [] };
}

/**
 * Interpolate string placeholders: {{key}} -> value
 */
function interpolate(text: string, data: Record<string, any>): string {
  return text.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, key) => {
    const val = data[key];
    return val !== undefined && val !== null ? String(val) : '';
  });
}

/**
 * Renders HTML email using an accessible, dark-mode friendly, table-based design system.
 */
export function renderEmail(
  templateKey: string,
  data: Record<string, any>,
  options: {
    tenantName?: string;
    brandColor?: string;
    supportEmail?: string;
    unsubscribeUrl?: string;
  } = {}
): RenderResult {
  const def = TEMPLATE_REGISTRY[templateKey];
  if (!def) {
    throw new Error(`Cannot render unknown template "${templateKey}"`);
  }

  const validation = validateTemplateVariables(templateKey, data);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const tenant = options.tenantName || 'GoRentals';
  const brandColor = options.brandColor || '#0d9488'; // Emerald/Teal primary
  const supportEmail = options.supportEmail || 'support@gorentals.example';
  const unsubscribeUrl = options.unsubscribeUrl || 'https://gorentals.example/notifications/preferences';

  const mergedData = { companyName: tenant, ...data };
  const subject = sanitizeHeader(interpolate(def.defaultSubject, mergedData));
  const preheader = sanitizeHeader(interpolate(def.preheader, mergedData));

  // Determine CTA
  const ctaText = def.ctaText ? interpolate(def.ctaText, mergedData) : null;
  const ctaUrl = def.ctaUrlTemplate ? interpolate(def.ctaUrlTemplate, mergedData) : null;

  // Build Key-Value Summary Table
  const tableRows: Array<[string, string]> = [];
  if (templateKey === 'BOOKING_CONFIRMED') {
    tableRows.push(['Booking ID', `#${data.bookingId}`]);
    tableRows.push(['Vehicle / Item', data.listingName]);
    tableRows.push(['Rental Dates', `${data.startDate} → ${data.endDate}`]);
    tableRows.push(['Total Paid', `${data.currency || 'USD'} ${data.totalAmount}`]);
    tableRows.push(['Pickup Location', data.pickupLocation]);
    if (data.depositAmount) tableRows.push(['Security Deposit', `${data.currency || 'USD'} ${data.depositAmount}`]);
  } else if (templateKey === 'PAYMENT_SUCCESS') {
    tableRows.push(['Invoice Number', `#${data.invoiceId}`]);
    tableRows.push(['Amount Processed', `${data.currency} ${data.amount}`]);
    tableRows.push(['Payment Method', data.paymentMethod]);
    tableRows.push(['Timestamp', data.date]);
  } else if (templateKey === 'REFUND_COMPLETED') {
    tableRows.push(['Refund Reference', `#${data.refundId}`]);
    tableRows.push(['Refund Amount', `${data.currency} ${data.amount}`]);
    tableRows.push(['Expected Delivery', `${data.estimatedArrivalDays} business days`]);
  } else if (templateKey === 'AUTH_OTP') {
    tableRows.push(['One-Time Passcode', String(data.otpCode)]);
    tableRows.push(['Validity Window', `${data.expiryMinutes} minutes`]);
  } else if (templateKey === 'OWNER_BOOKING_RECEIVED') {
    tableRows.push(['Renter', data.renterName]);
    tableRows.push(['Requested Item', data.listingName]);
    tableRows.push(['Dates', `${data.startDate} → ${data.endDate}`]);
    tableRows.push(['Your Net Payout', `$${data.payoutAmount}`]);
    tableRows.push(['Response Deadline', data.actionDeadline]);
  }

  const tableHtml = tableRows.length > 0
    ? `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0; border:1px solid #e2e8f0; border-radius:8px; overflow:hidden; border-collapse:separate;">
        ${tableRows
          .map(
            ([label, val]) => `
          <tr>
            <td style="padding:12px 16px; font-size:13px; color:#64748b; background-color:#f8fafc; border-bottom:1px solid #edf2f7; width:38%; font-weight:500;">
              ${escapeHtml(label)}
            </td>
            <td style="padding:12px 16px; font-size:14px; color:#0f172a; background-color:#ffffff; border-bottom:1px solid #edf2f7; font-weight:600;">
              ${escapeHtml(val)}
            </td>
          </tr>`
          )
          .join('')}
      </table>
    `
    : '';

  const ctaButtonHtml = ctaText && ctaUrl
    ? `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:28px 0 16px 0;">
        <tr>
          <td align="center">
            <a href="${escapeHtml(ctaUrl)}" target="_blank" rel="noopener noreferrer" style="display:inline-block; background-color:${brandColor}; color:#ffffff; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size:15px; font-weight:600; text-decoration:none; padding:14px 32px; border-radius:8px; box-shadow:0 1px 3px rgba(0,0,0,0.1);">
              ${escapeHtml(ctaText)} &rarr;
            </a>
          </td>
        </tr>
      </table>
    `
    : '';

  const otpHighlightHtml = templateKey === 'AUTH_OTP'
    ? `
      <div style="margin:24px 0; padding:20px; background-color:#f1f5f9; border-radius:8px; text-align:center;">
        <span style="font-family:monospace; font-size:32px; font-weight:700; letter-spacing:6px; color:#0f172a;">
          ${escapeHtml(data.otpCode)}
        </span>
        <div style="font-size:13px; color:#64748b; margin-top:8px;">
          This code expires in ${escapeHtml(data.expiryMinutes)} minutes. Never share it with anyone.
        </div>
      </div>
    `
    : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>${escapeHtml(subject)}</title>
  <!--[if mso]>
  <style type="text/css">
    body, table, td { font-family: Arial, Helvetica, sans-serif !important; }
  </style>
  <![endif]-->
</head>
<body style="margin:0; padding:0; background-color:#f4f6f8; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color:#334155; -webkit-font-smoothing:antialiased;">
  <!-- Preheader text (invisible in body, visible in inbox preview snippet) -->
  <div style="display:none; font-size:1px; color:#ffffff; line-height:1px; max-height:0px; max-width:0px; opacity:0; overflow:hidden;">
    ${escapeHtml(preheader)}
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f6f8; padding:32px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:580px; background-color:#ffffff; border-radius:12px; border:1px solid #e2e8f0; overflow:hidden; box-shadow:0 4px 6px -1px rgba(0, 0, 0, 0.05);">
          <!-- Header Banner -->
          <tr>
            <td style="background-color:#0f172a; padding:22px 32px; border-bottom:3px solid ${brandColor};">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <span style="font-size:20px; font-weight:700; color:#ffffff; letter-spacing:-0.5px;">
                      ${escapeHtml(tenant)}
                    </span>
                  </td>
                  <td align="right">
                    <span style="display:inline-block; font-size:11px; text-transform:uppercase; font-weight:600; padding:4px 8px; border-radius:4px; background-color:rgba(255,255,255,0.12); color:#94a3b8; letter-spacing:0.5px;">
                      ${escapeHtml(def.category)}
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Main Content Body -->
          <tr>
            <td style="padding:36px 32px 28px 32px;">
              <h1 style="margin:0 0 16px 0; font-size:22px; font-weight:700; color:#0f172a; line-height:1.3;">
                ${escapeHtml(subject)}
              </h1>
              
              <p style="margin:0 0 18px 0; font-size:15px; line-height:1.6; color:#334155;">
                Hello <strong>${escapeHtml(data.customerName || data.userName || data.ownerName || 'there')}</strong>,
              </p>

              <p style="margin:0 0 18px 0; font-size:15px; line-height:1.6; color:#475569;">
                ${escapeHtml(preheader)}
              </p>

              ${otpHighlightHtml}
              ${tableHtml}
              ${ctaButtonHtml}

              <p style="margin:24px 0 0 0; font-size:13px; line-height:1.5; color:#64748b;">
                If you have any questions, reply directly to this email or reach out to our team at
                <a href="mailto:${escapeHtml(supportEmail)}" style="color:${brandColor}; text-decoration:none;">${escapeHtml(supportEmail)}</a>.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color:#f8fafc; padding:20px 32px; border-top:1px solid #edf2f7; text-align:center;">
              <p style="margin:0 0 8px 0; font-size:12px; color:#94a3b8; line-height:1.5;">
                &copy; ${new Date().getFullYear()} ${escapeHtml(tenant)}. All rights reserved.
              </p>
              <p style="margin:0; font-size:11px; color:#94a3b8; line-height:1.5;">
                Delivered securely via Gmail Automation Engine.
                ${def.category !== 'authentication' ? `&bull; <a href="${escapeHtml(unsubscribeUrl)}" style="color:#64748b; text-decoration:underline;">Notification Preferences</a>` : ''}
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  // Accessible Plain Text alternative
  const plainTextRows = tableRows.map(([k, v]) => `* ${k}: ${v}`).join('\n');
  const text = `${tenant} — ${subject}
============================================================
Hello ${data.customerName || data.userName || data.ownerName || 'there'},

${preheader}

${data.otpCode ? `YOUR PASSCODE: ${data.otpCode} (Valid for ${data.expiryMinutes} minutes)\n` : ''}
${plainTextRows ? `${plainTextRows}\n` : ''}
${ctaUrl ? `Action Link: ${ctaUrl}\n` : ''}
Need assistance? Contact ${supportEmail}

© ${new Date().getFullYear()} ${tenant}. All rights reserved.
Delivered securely via Gmail Automation Engine.
`;

  return {
    subject,
    html,
    text,
    preheader,
    headers: {
      'X-Mailer': 'GmailAutomationEngine/1.0',
      'X-Auto-Response-Suppress': 'OOF, AutoReply',
      'List-Unsubscribe': `<${unsubscribeUrl}>, <mailto:${supportEmail}?subject=unsubscribe>`,
    },
  };
}
