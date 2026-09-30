// emails/refunds.tsx — preview mirrors of templates.ts refund_initiated /
// refund_failed / deposit_released v1. (refund_issued preview lives in booking-pair.tsx.)
// PREVIEW ONLY: production rendering lives in supabase/functions/notify-lifecycle/lib/templates.ts.
import { Text } from "@react-email/components";
import { Details, Layout, brand } from "./_layout";
import type { PreviewProps } from "./_layout";

const dash = `${brand.url}/dashboard`;

export function RefundInitiatedEmail(p: PreviewProps & { paymentMethod?: string; etaDays?: string }) {
  return (
    <Layout
      preview="We've started processing your refund."
      heading="Your refund is on its way 💸"
      ctaLabel="View booking"
      ctaHref={dash}
    >
      <Text style={{ fontSize: 15, lineHeight: "24px", color: "#3f3f46" }}>
        Hi {p.name}, we&apos;ve initiated a refund of <strong>{p.refundAmount ?? "the eligible amount"}</strong> to your
        original payment method{p.paymentMethod ? ` (${p.paymentMethod})` : ""}. Expected arrival:{" "}
        {p.etaDays ? `${p.etaDays} business days` : "5–10 business days"}. We&apos;ll email you again once it&apos;s issued.
      </Text>
      <Details listing={p.listing ?? "Your booking"} city={p.city} dates={p.dates ?? "—"} amount={p.refundAmount} />
    </Layout>
  );
}

export function RefundFailedEmail(p: PreviewProps & { reason?: string }) {
  return (
    <Layout
      preview="Your money is safe, but we need your help to return it."
      heading="We couldn't complete your refund ⚠️"
      ctaLabel="Contact support"
      ctaHref={`mailto:${brand.supportEmail}?subject=Refund%20failed`}
    >
      <Text style={{ fontSize: 15, lineHeight: "24px", color: "#3f3f46" }}>
        Hi {p.name}, our attempt to refund <strong>{p.refundAmount ?? "your money"}</strong> failed because{" "}
        {p.reason ?? "your payment provider could not accept the transfer"}.
      </Text>
      <Text style={{ fontSize: 14, lineHeight: "22px", color: "#1e40af", background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 8, padding: "12px 16px" }}>
        Your money is safe with us — it has NOT been lost. We just need updated details or a retry to send it back.
      </Text>
      <Text style={{ fontSize: 15, lineHeight: "24px", color: "#3f3f46" }}>
        Reply to this email or contact us at <strong>{brand.supportEmail}</strong> — usually resolved within one business day.
      </Text>
    </Layout>
  );
}

export function DepositReleasedEmail(p: PreviewProps & { deductions?: string; etaDays?: string }) {
  return (
    <Layout
      preview="Your deposit is coming back to you."
      heading="Security deposit released 🔓"
      ctaLabel="View booking"
      ctaHref={dash}
    >
      <Text style={{ fontSize: 15, lineHeight: "24px", color: "#3f3f46" }}>
        Hi {p.name}, your rental has been returned and inspected — we&apos;ve released your security deposit of{" "}
        <strong>{p.refundAmount ?? "the full deposit"}</strong>. Deductions: {p.deductions ?? "None"}. Expected arrival:{" "}
        {p.etaDays ? `${p.etaDays} business days` : "3–7 business days"}. If any deduction looks wrong, reply within 48 hours.
      </Text>
      <Details listing={p.listing ?? "Your booking"} city={p.city} dates={p.dates ?? "—"} amount={p.refundAmount} />
    </Layout>
  );
}

export default RefundInitiatedEmail;
