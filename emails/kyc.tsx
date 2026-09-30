// emails/kyc.tsx — preview mirrors of templates.ts kyc_submitted / kyc_approved /
// kyc_rejected / kyc_doc_expiring v1.
// PREVIEW ONLY: production rendering lives in supabase/functions/notify-lifecycle/lib/templates.ts.
import { Text } from "@react-email/components";
import { Layout, brand } from "./_layout";

const kyc = `${brand.url}/account/kyc`;

export function KycSubmittedEmail({ name = "there", documentType = "Aadhaar card" }: { name?: string; documentType?: string }) {
  return (
    <Layout
      preview="Most reviews finish within 24–48 hours."
      heading="Verification received 🔍"
      ctaLabel="Check verification status"
      ctaHref={kyc}
    >
      <Text style={{ fontSize: 15, lineHeight: "24px", color: "#3f3f46" }}>
        Hi {name}, we&apos;ve received your <strong>{documentType}</strong> documents. Our team is reviewing them now —
        most reviews finish within <strong>24–48 hours</strong>. We&apos;ll email you the moment there&apos;s an update.
      </Text>
    </Layout>
  );
}

export function KycApprovedEmail({ name = "there" }: { name?: string }) {
  return (
    <Layout
      preview="Identity verification complete. Full access unlocked."
      heading="You're verified ✅"
      ctaLabel="Browse rentals"
      ctaHref={`${brand.url}/search`}
    >
      <Text style={{ fontSize: 15, lineHeight: "24px", color: "#3f3f46" }}>
        Hi {name}, your identity verification is <strong>complete</strong>. You now have full access to book rentals on {brand.name}.
      </Text>
    </Layout>
  );
}

export function KycRejectedEmail({
  name = "there",
  reason = "Photo was blurred — all four corners of the document must be visible.",
}: {
  name?: string;
  reason?: string;
}) {
  return (
    <Layout
      preview={`Re-upload your documents to continue using ${brand.name}.`}
      heading="Action needed: verification unsuccessful ⚠️"
      ctaLabel="Re-upload documents"
      ctaHref={kyc}
    >
      <Text style={{ fontSize: 15, lineHeight: "24px", color: "#3f3f46" }}>
        Hi {name}, unfortunately we couldn&apos;t approve your verification this time.
      </Text>
      <Text style={{ fontSize: 14, lineHeight: "22px", color: "#92400e", background: "#fffbeb", border: "1px solid #fcd34d", borderRadius: 8, padding: "12px 16px" }}>
        Why: {reason}
      </Text>
      <Text style={{ fontSize: 15, lineHeight: "24px", color: "#3f3f46" }}>
        You can <strong>re-upload your documents</strong> right away — most re-submissions are approved on the next review.
        Questions? Reply to this email or write to {brand.supportEmail}.
      </Text>
    </Layout>
  );
}

export function KycDocExpiringEmail({
  name = "there",
  documentType = "Driving licence",
  expiresOn = "12 Oct 2026",
}: {
  name?: string;
  documentType?: string;
  expiresOn?: string;
}) {
  return (
    <Layout
      preview="Renew now to avoid interruptions to your bookings."
      heading={`Your ${documentType} expires soon 📅`}
      ctaLabel="Update document"
      ctaHref={kyc}
    >
      <Text style={{ fontSize: 15, lineHeight: "24px", color: "#3f3f46" }}>
        Hi {name}, your <strong>{documentType}</strong> expires on {expiresOn}. Upload the renewed copy now so your
        account stays verified and your bookings aren&apos;t interrupted. This only takes a minute — snap a photo and upload.
      </Text>
    </Layout>
  );
}

export default KycSubmittedEmail;
