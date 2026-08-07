/**
 * Structured activity logging for important gateway events.
 *
 * Format: [YYYY-MM-DD HH:MM:SS] LEVEL  event.name         key=val  key=val
 * This is human-readable in Render's log viewer and greppable for automation.
 */

export type ActivityLevel = "info" | "warn" | "error";

export type ActivityEvent =
  | "server.start"
  | "request.access"
  | "payment.challenge"
  | "payment.transfer_ok"
  | "payment.transfer_fail"
  | "payment.consumed"
  | "payment.prepaid_ok"
  | "payment.prepaid_fail"
  | "payment.session_ok"
  | "payment.session_fail"
  | "payment.x402_verified"
  | "payment.x402_settled"
  | "payment.settle_fail"
  | "payment.x402_fail"
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
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const badge =
    level === "error" ? "ERROR" : level === "warn" ? "WARN " : "INFO ";
  const kv = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${v}`)
    .join("  ");
  const line = `[${ts}] ${badge}  ${event.padEnd(28)} ${kv}`.trimEnd();

  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}
