/**
 * Structured activity logging for important gateway events.
 * Always writes a single JSON line so logs are greppable and machine-parseable.
 */

export type ActivityLevel = "info" | "warn" | "error";

export type ActivityEvent =
  | "server.start"
  | "payment.challenge"
  | "payment.transfer_ok"
  | "payment.transfer_fail"
  | "payment.consumed"
  | "payment.prepaid_ok"
  | "payment.prepaid_fail"
  | "payment.session_ok"
  | "payment.session_fail"
  | "credits.deposit_ok"
  | "credits.deposit_fail"
  | "credits.balance"
  | "ai.chat"
  | "ai.image"
  | "ai.code"
  | "ai.error"
  | "request.reject"
  | "relay.dispatch";

export interface ActivityFields {
  [key: string]: string | number | boolean | null | undefined;
}

export function activity(
  event: ActivityEvent,
  fields: ActivityFields = {},
  level: ActivityLevel = "info"
): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  });

  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}
