// emails/welcome.tsx — preview mirror of templates.ts `welcome` v1.
import { Text } from "@react-email/components";
import { Layout, brand } from "./_layout";

export default function WelcomeEmail({ name = "there" }: { name?: string }) {
  return (
    <Layout preview="Browse gear, book in a few taps, manage rentals in one dashboard." heading={`Welcome, ${name} 👋`} ctaLabel="Start browsing" ctaHref={brand.url}>
      <Text style={{ fontSize: 15, lineHeight: "24px", color: "#3f3f46" }}>
        Your GoRentals account is ready. You can now browse gear, book in a few taps, and manage every rental from one dashboard.
      </Text>
    </Layout>
  );
}
