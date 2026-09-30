// emails/otp.tsx — preview mirror of templates.ts `otp` v1.
// PREVIEW ONLY: production rendering lives in supabase/functions/notify-lifecycle/lib/templates.ts.
import { Text } from "@react-email/components";
import { Layout } from "./_layout";

export function OtpEmail({
  code = "482913",
  name = "there",
  actionType = "Sign in verification",
  expiryMinutes = 10,
}: {
  code?: string;
  name?: string;
  actionType?: string;
  expiryMinutes?: number;
}) {
  return (
    <Layout preview={`Your verification code — valid for ${expiryMinutes} minutes.`} heading="Your verification code">
      <Text style={{ fontSize: 15, lineHeight: "24px", color: "#3f3f46" }}>
        Hi {name}, use this code to complete <strong>{actionType}</strong>:
      </Text>
      <Text
        style={{
          fontSize: 32,
          fontWeight: 700,
          letterSpacing: 8,
          textAlign: "center",
          color: "#0f172a",
          background: "#f1f5f9",
          border: "1px solid #e2e8f0",
          borderRadius: 10,
          padding: "14px 28px",
          fontFamily: "'Courier New', Courier, monospace",
        }}
      >
        {code}
      </Text>
      <Text style={{ fontSize: 13, color: "#64748b" }}>Expires in {expiryMinutes} minutes · {actionType}</Text>
      <Text style={{ fontSize: 14, lineHeight: "22px", color: "#92400e", background: "#fffbeb", border: "1px solid #fcd34d", borderRadius: 8, padding: "12px 16px" }}>
        ⚠️ GoRentls staff will NEVER ask you for this code. Didn&apos;t request it? Ignore this email — your account stays secure.
      </Text>
    </Layout>
  );
}

export default OtpEmail;
