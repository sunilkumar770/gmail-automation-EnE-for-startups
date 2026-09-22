// emails/_layout.tsx — shared preview shell for React Email (`npx email dev --dir emails`).
// PREVIEW ONLY: the production send path renders supabase/functions/notify-lifecycle/lib/templates.ts
// (Deno cannot compile React Email JSX reliably — see supabase/discussions#40286).
// Keep copy/headings in sync; the mirror unit test (tests/unit/lib.test.mjs) fails on drift.
import {
  Html, Head, Preview, Body, Container, Section, Text, Button, Hr,
} from "@react-email/components";
import type { ReactNode } from "react";

export const brand = {
  name: "GoRentals",
  color: "#0F766E",
  url: "https://gorentals.com",
};

export function Layout(props: {
  preview: string;
  heading: string;
  children: ReactNode;
  ctaLabel?: string;
  ctaHref?: string;
  marketing?: boolean;
  unsubHref?: string;
}) {
  return (
    <Html>
      <Head />
      <Preview>{props.preview}</Preview>
      <Body style={{ background: "#f4f4f5", fontFamily: "ui-sans-serif, system-ui" }}>
        <Container style={{ background: "#fff", margin: "24px auto", padding: "32px", borderRadius: 12, maxWidth: 560 }}>
          <Text style={{ color: brand.color, fontSize: 20, fontWeight: 700, margin: 0 }}>{brand.name}</Text>
          <Text style={{ fontSize: 22, fontWeight: 700, color: "#111", margin: "24px 0 8px" }}>{props.heading}</Text>
          <Section>{props.children}</Section>
          {props.ctaHref && (
            <Button href={props.ctaHref} style={{ background: brand.color, color: "#fff", padding: "12px 20px", borderRadius: 8, marginTop: 16 }}>
              {props.ctaLabel ?? "Open dashboard"}
            </Button>
          )}
          <Hr style={{ marginTop: 32, borderColor: "#e4e4e7" }} />
          <Text style={{ fontSize: 12, color: "#a1a1aa" }}>
            GoRentals · gorentals.com
            {props.marketing && props.unsubHref && (
              <>
                {" · "}
                <a href={props.unsubHref} style={{ color: "#a1a1aa" }}>Unsubscribe</a>
              </>
            )}
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export function Details(props: { listing: string; city?: string | null; dates: string; amount?: string | null }) {
  return (
    <Text style={{ fontSize: 15, lineHeight: "24px", color: "#3f3f46" }}>
      {props.listing}
      {props.city ? ` · ${props.city}` : ""}
      <br />
      {props.dates}
      {props.amount ? (
        <>
          <br />
          Total: {props.amount}
        </>
      ) : null}
    </Text>
  );
}

// Preview-only props mirror the outbox payload contract (lib/schemas.ts).
export type PreviewProps = {
  role?: "renter" | "owner";
  name?: string;
  listing?: string;
  city?: string;
  dates?: string;
  amount?: string;
  refundAmount?: string;
};
