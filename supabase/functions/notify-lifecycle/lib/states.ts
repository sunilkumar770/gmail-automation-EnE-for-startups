// ============================================================================
// lib/states.ts — Email state machine (TS mirror of the SQL source of truth)
// ============================================================================
// The DATABASE enforces transitions (email_state_transition_ok /
// email_apply_provider_state). This mirror exists for unit tests and for
// defensive worker-side checks; if they ever disagree, the DB wins.
//
// State ownership:
//   application-originated: QUEUED CLAIMED SENDING RETRY_WAIT UNKNOWN DEAD
//                           CANCELLED SUPPRESSED
//   provider-originated:    ACCEPTED DELAYED DELIVERED FAILED BOUNCED COMPLAINED
// Terminal: DEAD CANCELLED COMPLAINED (BOUNCED/FAILED replayable via operator)

export const EMAIL_STATES = [
  "QUEUED", "CLAIMED", "SENDING", "ACCEPTED", "DELAYED", "DELIVERED",
  "BOUNCED", "COMPLAINED", "FAILED", "RETRY_WAIT", "UNKNOWN",
  "DEAD", "CANCELLED", "SUPPRESSED",
] as const;
export type EmailState = (typeof EMAIL_STATES)[number];

/** App-originated transition matrix (must match SQL email_state_transition_ok). */
export const APP_TRANSITIONS: Record<string, readonly EmailState[]> = {
  QUEUED:     ["CLAIMED", "CANCELLED", "SUPPRESSED", "DEAD"],
  CLAIMED:    ["SENDING", "QUEUED", "DEAD", "SUPPRESSED", "CANCELLED"],
  SENDING:    ["ACCEPTED", "UNKNOWN", "RETRY_WAIT", "DEAD"],
  UNKNOWN:    ["CLAIMED", "ACCEPTED", "RETRY_WAIT", "DEAD"],
  RETRY_WAIT: ["CLAIMED", "DEAD", "CANCELLED"],
  ACCEPTED:   [],
  DELAYED:    [],
  DELIVERED:  [],
  FAILED:     ["QUEUED"],     // operator replay only
  DEAD:       ["QUEUED"],     // operator replay only
  BOUNCED:    ["QUEUED"],     // operator replay only (unsuppress first)
  SUPPRESSED: ["QUEUED"],     // operator replay only (unsuppress first)
  COMPLAINED: [],
  CANCELLED:  [],
};

/** Provider ranks: a provider event may only ADVANCE the rank (out-of-order safe). */
export const PROVIDER_RANKS: Record<string, number> = {
  QUEUED: 10, CLAIMED: 20, SENDING: 30, UNKNOWN: 35, RETRY_WAIT: 40,
  ACCEPTED: 50, DELAYED: 55, DELIVERED: 60, FAILED: 65, BOUNCED: 70,
  SUPPRESSED: 80, COMPLAINED: 85, DEAD: 90, CANCELLED: 95,
};

export const PROVIDER_STATES = new Set(["ACCEPTED", "DELAYED", "DELIVERED", "FAILED", "BOUNCED", "COMPLAINED"]);

export function canAppTransition(from: EmailState, to: EmailState): boolean {
  return (APP_TRANSITIONS[from] ?? []).includes(to);
}

export function canProviderAdvance(from: EmailState, to: EmailState): boolean {
  if (!PROVIDER_STATES.has(to)) return false;
  const cur = PROVIDER_RANKS[from] ?? -1;
  if (cur < 30) return false;             // never apply to unsent rows
  return (PROVIDER_RANKS[to] ?? -1) > cur;
}

export function isTerminal(s: EmailState): boolean {
  return s === "DEAD" || s === "CANCELLED" || s === "COMPLAINED";
}

export const TERMINAL_STATES: readonly EmailState[] = ["DEAD", "CANCELLED", "COMPLAINED"];
export const REPLAYABLE_STATES: readonly EmailState[] = ["DEAD", "FAILED", "BOUNCED", "SUPPRESSED"];
