// emails/booking-pair.tsx — preview mirrors of the renter/owner booking emails.
// One file per lifecycle stage keeps `npx email dev --dir emails` navigable.
import { Text } from "@react-email/components";
import { Details, Layout, brand, type PreviewProps } from "./_layout";

const dash = `${brand.url}/dashboard`;

export function BookingRequestEmail(p: PreviewProps) {
  const renter = (p.role ?? "renter") === "renter";
  return (
    <Layout
      preview={renter ? `Booking request for ${p.listing}` : "New booking request"}
      heading={renter ? "We received your booking request" : `${p.name} requested this listing`}
      ctaHref={dash}
    >
      <Text style={{ fontSize: 15, lineHeight: "24px", color: "#3f3f46" }}>
        {renter
          ? `Hi ${p.name}, your request is in. The owner will confirm shortly.`
          : `Hi ${p.name}, a renter wants this listing. Confirm or decline in your dashboard.`}
      </Text>
      <Details listing={p.listing ?? "Your booking"} city={p.city} dates={p.dates ?? "—"} amount={p.amount} />
    </Layout>
  );
}

export function BookingConfirmedEmail(p: PreviewProps) {
  const renter = (p.role ?? "renter") === "renter";
  return (
    <Layout
      preview={renter ? "Your booking is confirmed. Details inside." : "A renter just booked your listing."}
      heading={renter ? `You're all set, ${p.name}! 🎉` : `Heads up, ${p.name} 👋`}
      ctaLabel={renter ? "View my booking" : "Manage this booking"}
      ctaHref={dash}
    >
      <Text style={{ fontSize: 15, lineHeight: "24px", color: "#3f3f46" }}>
        {renter
          ? "Your booking is confirmed. Save this email — it's your receipt."
          : "Your listing was just booked and payment is secured. Please prep the item for check-in."}
      </Text>
      <Details listing={p.listing ?? "Your booking"} city={p.city} dates={p.dates ?? "—"} amount={p.amount} />
    </Layout>
  );
}

export function BookingCancelledEmail(p: PreviewProps) {
  const renter = (p.role ?? "renter") === "renter";
  return (
    <Layout
      preview={renter ? "Cancellation details and what happens next." : "A booking on your listing was cancelled."}
      heading={renter ? "Your booking was cancelled" : "A booking was cancelled"}
      ctaHref={dash}
    >
      <Text style={{ fontSize: 15, lineHeight: "24px", color: "#3f3f46" }}>
        {renter
          ? "If a refund applies, it is processed automatically and you'll receive a separate confirmation within 5–10 business days."
          : "This booking is no longer active. Your calendar has been reopened automatically."}
      </Text>
      <Details listing={p.listing ?? "Your booking"} city={p.city} dates={p.dates ?? "—"} />
    </Layout>
  );
}

export function BookingRefundedEmail(p: PreviewProps) {
  const renter = (p.role ?? "renter") === "renter";
  return (
    <Layout
      preview={renter ? "We've issued your refund." : "A refund was issued on your listing."}
      heading={renter ? "Your refund is on the way 💸" : "Refund issued"}
      ctaHref={dash}
    >
      <Text style={{ fontSize: 15, lineHeight: "24px", color: "#3f3f46" }}>
        {renter
          ? `Hi ${p.name}, we processed ${p.refundAmount ?? "your refund"} to your original payment method. Expect it within 5–10 business days.`
          : `${p.refundAmount ?? "A refund"} was issued to the renter for this booking.`}
      </Text>
      <Details listing={p.listing ?? "Your booking"} city={p.city} dates={p.dates ?? "—"} amount={p.refundAmount} />
    </Layout>
  );
}

export function BookingReminderEmail(p: PreviewProps) {
  return (
    <Layout preview="Your rental starts soon. Here's what to know." heading="Your rental starts soon ⏰" ctaLabel="Check-in details" ctaHref={dash}>
      <Text style={{ fontSize: 15, lineHeight: "24px", color: "#3f3f46" }}>
        {`Hi ${p.name}, friendly reminder that your rental starts soon (local time). Review the handover instructions and contact the host early if anything is unclear.`}
      </Text>
      <Details listing={p.listing ?? "Your booking"} city={p.city} dates={p.dates ?? "—"} />
    </Layout>
  );
}

export function ReviewRequestEmail(p: PreviewProps & { reviewHref?: string; unsubHref?: string }) {
  return (
    <Layout
      preview="30 seconds of your time helps the whole community."
      heading="How did it go? ⭐"
      ctaLabel="Leave a review"
      ctaHref={p.reviewHref ?? dash}
      marketing
      unsubHref={p.unsubHref}
    >
      <Text style={{ fontSize: 15, lineHeight: "24px", color: "#3f3f46" }}>
        {`Hi ${p.name}, you recently rented on GoRentals. Honest reviews keep the community trustworthy — would you take 30 seconds to rate it?`}
      </Text>
    </Layout>
  );
}

export function WinBackEmail(p: PreviewProps & { unsubHref?: string }) {
  return (
    <Layout
      preview="Fresh listings near you, ready to roll."
      heading="Ready for the next trip? 🚐"
      ctaLabel="Browse rentals"
      ctaHref={`${brand.url}/listings`}
      marketing
      unsubHref={p.unsubHref}
    >
      <Text style={{ fontSize: 15, lineHeight: "24px", color: "#3f3f46" }}>
        {`Hi ${p.name}, it's been a while! New RVs, campers and gear are listed every day on GoRentals.`}
      </Text>
    </Layout>
  );
}

export default BookingConfirmedEmail;
