/**
 * Session-based prepaid payment for paid routes.
 * Validates Bearer session token and debits the prepaid USDT ledger.
 */

import { debitPrepaid, getPrepaidBalance, verifySessionToken } from "./prepaid-ledger.js";
import { activity } from "./activity-log.js";

export const SESSION_HEADER = "authorization";
export const PAYER_HEADER = "x-agentpay-payer";

export interface SessionPayResult {
  address: string;
  remainingAtomic: bigint;
  chargedAtomic: bigint;
}

/**
 * Try to pay `amountAtomic` from a session token.
 * Returns null if no Authorization bearer is present (caller should try other methods).
 * Throws if token invalid or balance insufficient.
 */
export function trySessionPayment(
  authHeader: string | undefined,
  amountAtomic: bigint,
  path: string
): SessionPayResult | null {
  if (!authHeader) return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;

  const token = m[1].trim();
  try {
    const session = verifySessionToken(token);
    const remaining = debitPrepaid(session.address, amountAtomic);
    activity("payment.session_ok", {
      address: session.address,
      path,
      chargedAtomic: amountAtomic.toString(),
      remainingAtomic: remaining.toString(),
    });
    return {
      address: session.address,
      remainingAtomic: remaining,
      chargedAtomic: amountAtomic,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Session payment failed";
    activity("payment.session_fail", { path, reason: message }, "warn");
    throw err;
  }
}

export function peekSessionBalance(authHeader: string | undefined): bigint | null {
  if (!authHeader) return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  try {
    const session = verifySessionToken(m[1].trim());
    return getPrepaidBalance(session.address);
  } catch {
    return null;
  }
}
