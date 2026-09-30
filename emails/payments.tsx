// emails/payments.tsx — preview mirrors of templates.ts payment_receipt /
// payment_failed v1.
// PREVIEW ONLY: production rendering lives in supabase/functions/notify-lifecycle/lib/templates.ts.
// Invoice delivery decision: signed time-limited PDF LINK (app-minted invoice_url),
// not a raw attachment — smaller outbox rows + download analytics.
import { Text } from "@react-email/components";
import { Details, Layout, brand } from "./_layout";
import type { PreviewProps } from "./_layout";

const dash = `${brand.url}/dashboard`;

export function PaymentReceiptEmail(
  p: PreviewProps & { invoiceId?: string; invoiceUrl?: string; paymentMethod?: string; paidOn?: string },
) {
  return (
    <Layout
      preview="Thanks! Your payment is confirmed."
      heading="Payment received ✅"
      ctaLabel={p.invoiceUrl ? "Download invoice (PDF)" : "View booking"}
      ctaHref={p.invoiceUrl ?? dash}
    >
      <Text style={{ fontSize: 15, lineHeight: "24px", color: "#3f3f46" }}>
        Hi {p.name}, we&apos;ve received your payment of <strong>{p.amount ?? "the amount due"}</strong>. Thank you!
        {p.invoiceId ? ` Invoice: ${p.invoiceId}.` : ""}
        {p.paymentMethod ? ` Paid via ${p.paymentMethod}.` : ""}
        {p.paidOn ? ` Paid on ${p.paidOn}.` : ""}
      </Text>
      <Details listing={p.listing ?? "Your booking"} city={p.city} dates={p.dates ?? "—"} amount={p.amount} />
    </Layout>
  );
}

export function PaymentFailedEmail(p: PreviewProps & { reason?: string; retryUrl?: string }) {
  return (
    <Layout
      preview="Retry now to avoid losing your reservation."
      heading="Payment failed ⚠️"
      ctaLabel="Retry payment"
      ctaHref={p.retryUrl ?? dash}
    >
      <Text style={{ fontSize: 15, lineHeight: "24px", color: "#3f3f46" }}>
        Hi {p.name}, we couldn&apos;t process your payment{p.amount ? ` of ${p.amount}` : ""} because{" "}
        {p.reason ?? "your payment provider declined the charge"}.
      </Text>
      <Text style={{ fontSize: 14, lineHeight: "22px", color: "#92400e", background: "#fffbeb", border: "1px solid #fcd34d", borderRadius: 8, padding: "12px 16px" }}>
        If this payment was for a pending booking, the reservation may be released if the payment isn&apos;t completed soon.
      </Text>
      <Text style={{ fontSize: 15, lineHeight: "24px", color: "#3f3f46" }}>
        Try a different card/UPI handle, or contact us at {brand.supportEmail} if the problem persists.
      </Text>
    </Layout>
  );
}

export default PaymentReceiptEmail;
