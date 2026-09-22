export interface EventPreset {
  category: 'authentication' | 'customer' | 'owner' | 'platform';
  event: string;
  name: string;
  description: string;
  defaultEntityId: string;
  recipientEmail: string;
  recipientName: string;
  data: Record<string, any>;
}

export const GORENTLS_EVENT_CATALOG: EventPreset[] = [
  // Authentication
  {
    category: 'authentication',
    event: 'AUTH_WELCOME',
    name: 'User Welcome',
    description: 'Triggered when a renter or owner signs up.',
    defaultEntityId: 'usr_88291',
    recipientEmail: 'sarah.miller@example.com',
    recipientName: 'Sarah Miller',
    data: {
      userName: 'Sarah Miller',
      verificationLink: 'https://gorentals.example/verify?token=abc88291',
      companyName: 'GoRentals',
    },
  },
  {
    category: 'authentication',
    event: 'AUTH_OTP',
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
    name: 'Booking Confirmed',
    description: 'Triggered when payment is authorized and owner locks the reservation.',
    defaultEntityId: 'bkg_49204',
    recipientEmail: 'david.chen@example.com',
    recipientName: 'David Chen',
    data: {
      customerName: 'David Chen',
      bookingId: '49204',
      listingName: '2024 Tesla Model Y Long Range',
      startDate: 'Oct 12, 2026 10:00 AM',
      endDate: 'Oct 15, 2026 06:00 PM',
      totalAmount: '389.00',
      depositAmount: '200.00',
      currency: 'USD',
      pickupLocation: 'Downtown Mobility Hub, Terminal 2',
      ownerName: 'Alex Rivers',
    },
  },
  {
    category: 'customer',
    event: 'PAYMENT_SUCCESS',
    name: 'Payment Receipt',
    description: 'Immediate receipt following credit card or ACH charge.',
    defaultEntityId: 'inv_91823',
    recipientEmail: 'david.chen@example.com',
    recipientName: 'David Chen',
    data: {
      customerName: 'David Chen',
      invoiceId: 'INV-91823',
      bookingId: '49204',
      amount: '589.00',
      currency: 'USD',
      paymentMethod: 'Visa ending in •••• 4242',
      date: 'Oct 10, 2026, 09:14 AM UTC',
    },
  },
  {
    category: 'customer',
    event: 'RENTAL_STARTING_SOON',
    name: 'Rental Starting Tomorrow',
    description: 'Automated 24-hour reminder before pickup.',
    defaultEntityId: 'bkg_49204',
    recipientEmail: 'david.chen@example.com',
    recipientName: 'David Chen',
    data: {
      customerName: 'David Chen',
      bookingId: '49204',
      listingName: '2024 Tesla Model Y Long Range',
      startDate: 'Oct 12, 2026 10:00 AM',
      pickupLocation: 'Downtown Mobility Hub, Keybox Slot #14',
      securityPin: '8294',
    },
  },
  {
    category: 'customer',
    event: 'REFUND_COMPLETED',
    name: 'Security Deposit Refunded',
    description: 'Dispatched when post-trip vehicle inspection passes.',
    defaultEntityId: 'ref_20914',
    recipientEmail: 'david.chen@example.com',
    recipientName: 'David Chen',
    data: {
      customerName: 'David Chen',
      refundId: 'REF-20914',
      bookingId: '49204',
      amount: '200.00',
      currency: 'USD',
      estimatedArrivalDays: '2-3',
    },
  },
  {
    category: 'customer',
    event: 'REVIEW_REQUESTED',
    name: 'Post-Trip Review Request',
    description: 'Sent 2 hours after vehicle return.',
    defaultEntityId: 'bkg_49204',
    recipientEmail: 'david.chen@example.com',
    recipientName: 'David Chen',
    data: {
      customerName: 'David Chen',
      bookingId: '49204',
      listingName: '2024 Tesla Model Y Long Range',
      reviewUrl: 'https://gorentals.example/review/49204',
      ownerName: 'Alex Rivers',
    },
  },

  // Owner Lifecycle
  {
    category: 'owner',
    event: 'OWNER_BOOKING_RECEIVED',
    name: 'Owner: New Booking Request',
    description: 'Alerts vehicle owner of pending reservation request.',
    defaultEntityId: 'bkg_51029',
    recipientEmail: 'alex.rivers@example.com',
    recipientName: 'Alex Rivers',
    data: {
      ownerName: 'Alex Rivers',
      renterName: 'Elena Rostova',
      listingName: '2023 Porsche Taycan 4S',
      startDate: 'Nov 01, 2026',
      endDate: 'Nov 04, 2026',
      payoutAmount: '820.00',
      actionDeadline: '12 hours',
    },
  },
  {
    category: 'owner',
    event: 'OWNER_PAYOUT_COMPLETED',
    name: 'Owner: Payout Dispatched',
    description: 'Notification when earnings are wired to host bank account.',
    defaultEntityId: 'po_88192',
    recipientEmail: 'alex.rivers@example.com',
    recipientName: 'Alex Rivers',
    data: {
      ownerName: 'Alex Rivers',
      payoutId: 'PO-88192',
      amount: '820.00',
      currency: 'USD',
      bankAccountLast4: '9182',
      payoutDate: 'Oct 18, 2026',
      bookingId: '51029',
    },
  },

  // Platform Ops
  {
    category: 'platform',
    event: 'SYSTEM_ALERT',
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
