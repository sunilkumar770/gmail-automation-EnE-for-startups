export interface EventPreset {
  category: 'authentication' | 'customer' | 'owner' | 'platform';
  event: string;
  name: string;
  description: string;
  defaultEntityId: string;
  recipientEmail: string;
  recipientName: string;
  data: Record<string, any>;
  /** Production template key (migration 001–003 registry) this event maps to.
   *  Empty string = no production template yet (see engine/liveCatalog.ts). */
  templateKey?: string;
}

export const GORENTLS_EVENT_CATALOG: EventPreset[] = [
  // Authentication
  {
    category: 'authentication',
    event: 'AUTH_WELCOME',
    templateKey: 'welcome',
    name: 'User Welcome',
    description: 'Triggered when a renter or owner signs up.',
    defaultEntityId: 'usr_88291',
    recipientEmail: 'sarah.miller@example.com',
    recipientName: 'Sarah Miller',
    data: {
      userName: 'Sarah Miller',
      verificationLink: 'https://www.gorentls.com/verify?token=abc88291',
      companyName: 'GoRentls',
    },
  },
  {
    category: 'authentication',
    event: 'AUTH_OTP',
    templateKey: 'otp',
    name: 'Login OTP / 2FA Code',
    description: 'Sent during sign-in verification or sensitive payout update.',
    defaultEntityId: 'usr_88291',
    recipientEmail: 'sarah.miller@example.com',
    recipientName: 'Sarah Miller',
    data: {
      userName: 'Sarah Miller',
      otpCode: '849201',
      expiryMinutes: 10,
      actionType: 'Sign in verification',
    },
  },

  // Customer Lifecycle
  {
    category: 'customer',
    event: 'BOOKING_CONFIRMED',
    templateKey: 'booking_confirmation',
    name: 'Booking Confirmed',
    description: 'Triggered when payment is authorized and owner locks the reservation.',
    defaultEntityId: 'bkg_49204',
    recipientEmail: 'david.chen@example.com',
    recipientName: 'David Chen',
    data: {
      customerName: 'David Chen',
      bookingId: '49204',
      listingName: 'Canon EOS R5 Kit',
      startDate: 'Oct 12, 2026 10:00 AM',
      endDate: 'Oct 15, 2026 06:00 PM',
      totalAmount: '7500.00',
      depositAmount: '4000.00',
      currency: 'INR',
      pickupLocation: 'Jubilee Hills Pickup Point, Hyderabad',
      ownerName: 'Alex Rivers',
    },
  },
  {
    category: 'customer',
    event: 'PAYMENT_SUCCESS',
    templateKey: 'payment_receipt',
    name: 'Payment Receipt',
    description: 'Immediate receipt following credit card or ACH charge.',
    defaultEntityId: 'inv_91823',
    recipientEmail: 'david.chen@example.com',
    recipientName: 'David Chen',
    data: {
      customerName: 'David Chen',
      invoiceId: 'INV-91823',
      bookingId: '49204',
      amount: '11500.00',
      currency: 'INR',
      paymentMethod: 'Visa ending in •••• 4242',
      date: 'Oct 10, 2026, 09:14 AM UTC',
    },
  },
  {
    category: 'customer',
    event: 'RENTAL_STARTING_SOON',
    templateKey: 'booking_reminder',
    name: 'Rental Starting Tomorrow',
    description: 'Automated 24-hour reminder before pickup.',
    defaultEntityId: 'bkg_49204',
    recipientEmail: 'david.chen@example.com',
    recipientName: 'David Chen',
    data: {
      customerName: 'David Chen',
      bookingId: '49204',
      listingName: 'Canon EOS R5 Kit',
      startDate: 'Oct 12, 2026 10:00 AM',
      pickupLocation: 'Jubilee Hills Pickup Point, Keybox Slot #14',
      securityPin: '8294',
    },
  },
  {
    category: 'customer',
    event: 'REFUND_COMPLETED',
    templateKey: 'refund_issued',
    name: 'Security Deposit Refunded',
    description: 'Dispatched when post-trip vehicle inspection passes.',
    defaultEntityId: 'ref_20914',
    recipientEmail: 'david.chen@example.com',
    recipientName: 'David Chen',
    data: {
      customerName: 'David Chen',
      refundId: 'REF-20914',
      bookingId: '49204',
      amount: '4000.00',
      currency: 'INR',
      estimatedArrivalDays: '2-3',
    },
  },
  {
    category: 'customer',
    event: 'REVIEW_REQUESTED',
    templateKey: 'review_request',
    name: 'Post-Trip Review Request',
    description: 'Sent 2 hours after vehicle return.',
    defaultEntityId: 'bkg_49204',
    recipientEmail: 'david.chen@example.com',
    recipientName: 'David Chen',
    data: {
      customerName: 'David Chen',
      bookingId: '49204',
      listingName: 'Canon EOS R5 Kit',
      reviewUrl: 'https://www.gorentls.com/review/49204',
      ownerName: 'Alex Rivers',
    },
  },

  // Owner Lifecycle
  {
    category: 'owner',
    event: 'OWNER_BOOKING_RECEIVED',
    templateKey: 'booking_request_owner',
    name: 'Owner: New Booking Request',
    description: 'Alerts vehicle owner of pending reservation request.',
    defaultEntityId: 'bkg_51029',
    recipientEmail: 'alex.rivers@example.com',
    recipientName: 'Alex Rivers',
    data: {
      ownerName: 'Alex Rivers',
      renterName: 'Elena Rostova',
      listingName: 'Royal Enfield Himalayan 450',
      startDate: 'Nov 01, 2026',
      endDate: 'Nov 04, 2026',
      payoutAmount: '24000.00',
      actionDeadline: '12 hours',
    },
  },
  {
    category: 'owner',
    event: 'OWNER_PAYOUT_COMPLETED',
    templateKey: '',
    name: 'Owner: Payout Dispatched',
    description: 'Notification when earnings are wired to host bank account.',
    defaultEntityId: 'po_88192',
    recipientEmail: 'alex.rivers@example.com',
    recipientName: 'Alex Rivers',
    data: {
      ownerName: 'Alex Rivers',
      payoutId: 'PO-88192',
      amount: '24000.00',
      currency: 'INR',
      bankAccountLast4: '9182',
      payoutDate: 'Oct 18, 2026',
      bookingId: '51029',
    },
  },

  // Platform Ops
  {
    category: 'platform',
    event: 'SYSTEM_ALERT',
    templateKey: '',
    name: 'Platform Operations Alert',
    description: 'Internal operations/on-call notification.',
    defaultEntityId: 'inc_4401',
    recipientEmail: 'oncall@gorentals.example',
    recipientName: 'Ops On-Call Engineer',
    data: {
      incidentId: 'INC-4401',
      severity: 'HIGH',
      serviceName: 'StripeWebhookWorker',
      summary: 'Stripe charge.failed event rate exceeded threshold (>5% in 5m)',
      timestamp: '2026-09-21T22:45:00Z',
    },
  },
];
