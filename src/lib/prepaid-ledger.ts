/**
 * Prepaid USDT credit ledger + session tokens.
 *
 * Credits survive process restarts via a JSON file under `.data/`.
 * Session tokens are HMAC-signed and bind to the payer address.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const balances = new Map<string, bigint>();
const creditedDeposits = new Set<string>();

const DATA_DIR = process.env.VERCEL
  ? join("/tmp", "agentpay-data")
  : join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".data");
const LEDGER_PATH = join(DATA_DIR, "prepaid-ledger.json");

function norm(addr: string): string {
  return addr.toLowerCase();
}

function persist(): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    const payload = {
      balances: Object.fromEntries(
        [...balances.entries()].map(([k, v]) => [k, v.toString()])
      ),
      deposits: [...creditedDeposits],
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(LEDGER_PATH, JSON.stringify(payload, null, 2), "utf8");
  } catch (err) {
    console.warn("[ledger] persist failed:", err);
  }
}

function hydrate(): void {
  try {
    if (!existsSync(LEDGER_PATH)) return;
    const raw = JSON.parse(readFileSync(LEDGER_PATH, "utf8")) as {
      balances?: Record<string, string>;
      deposits?: string[];
    };
    balances.clear();
    creditedDeposits.clear();
    for (const [k, v] of Object.entries(raw.balances ?? {})) {
      try {
        balances.set(norm(k), BigInt(v));
      } catch {
        /* skip bad row */
      }
    }
    for (const d of raw.deposits ?? []) {
      creditedDeposits.add(d.toLowerCase());
    }
    console.log(
      `[ledger] hydrated ${balances.size} accounts, ${creditedDeposits.size} deposits from disk`
    );
  } catch (err) {
    console.warn("[ledger] hydrate failed:", err);
  }
}

hydrate();

export function getPrepaidBalance(address: string): bigint {
  return balances.get(norm(address)) ?? BigInt(0);
}

export function creditPrepaid(
  address: string,
  amountAtomic: bigint,
  depositTxHash: string
): bigint {
  const tx = depositTxHash.toLowerCase();
  if (creditedDeposits.has(tx)) {
    throw new Error("This deposit transaction was already credited.");
  }
  if (amountAtomic <= BigInt(0)) {
    throw new Error("Deposit amount must be positive.");
  }
  const key = norm(address);
  const next = (balances.get(key) ?? BigInt(0)) + amountAtomic;
  balances.set(key, next);
  creditedDeposits.add(tx);
  if (creditedDeposits.size > 50_000) {
    const first = creditedDeposits.values().next().value;
    if (first) creditedDeposits.delete(first);
  }
  persist();
  return next;
}

export function debitPrepaid(address: string, amountAtomic: bigint): bigint {
  const key = norm(address);
  const current = balances.get(key) ?? BigInt(0);
  if (current < amountAtomic) {
    throw new Error(
      `Insufficient prepaid USDT credit. Have ${current.toString()}, need ${amountAtomic.toString()}.`
    );
  }
  const next = current - amountAtomic;
  balances.set(key, next);
  persist();
  return next;
}

export function _resetLedgerForTests(): void {
  balances.clear();
  creditedDeposits.clear();
  try {
    if (existsSync(LEDGER_PATH)) writeFileSync(LEDGER_PATH, "{}", "utf8");
  } catch {
    /* ignore */
  }
}

// ─── Session tokens (HMAC) ───────────────────────────────────────────────────

export interface SessionPayload {
  address: string;
  exp: number;
}

function sessionSecret(): string {
  return (
    process.env.SESSION_SECRET ||
    process.env.PAYMENT_OPERATOR_PRIVATE_KEY ||
    "agentpay-dev-session-secret-change-me"
  );
}

/** Default 30 days — user should not re-auth every day for a micropayment app. */
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 30;

export function issueSessionToken(
  address: string,
  ttlSeconds = DEFAULT_TTL_SECONDS
): string {
  const payload: SessionPayload = {
    address: norm(address),
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", sessionSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifySessionToken(token: string): SessionPayload {
  const parts = token.split(".");
  if (parts.length !== 2) {
    throw new Error("Invalid session token format.");
  }
  const [body, sig] = parts;
  const expected = createHmac("sha256", sessionSecret()).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error("Invalid session token signature.");
  }
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
  if (!payload.address || !payload.exp) {
    throw new Error("Invalid session token payload.");
  }
  if (payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error("Session expired. Authorize spending again.");
  }
  return payload;
}

export async function handleCreditsDeposit(
  req: any,
  res: any,
  opts: { usdtAddress: string; payTo: string; chainId: number; rpcUrl: string; network: string }
) {
  const body = req.body || {};
  const txHash = body.txHash;
  if (!txHash || typeof txHash !== "string") {
    return res.status(400).json({ error: "Missing txHash string in body" });
  }

  try {
    const { verifyUsdtTransferPayment } = await import("./usdt-transfer-payment.js");
    const { activity } = await import("./activity-log.js");
    const verified = await verifyUsdtTransferPayment({
      txHash,
      apayAddress: opts.usdtAddress as `0x${string}`,
      payTo: opts.payTo as `0x${string}`,
      minAmountAtomic: BigInt(1),
      chainId: opts.chainId,
      rpcUrl: opts.rpcUrl,
    });

    const newBalance = creditPrepaid(verified.from, verified.amount, verified.txHash);
    const sessionToken = issueSessionToken(verified.from);

    activity("credits.deposit_ok", {
      from: verified.from,
      txHash: verified.txHash,
      amountAtomic: verified.amount.toString(),
      newBalanceAtomic: newBalance.toString(),
    });

    return res.json({
      success: true,
      address: verified.from,
      amountAtomic: verified.amount.toString(),
      newBalanceAtomic: newBalance.toString(),
      sessionToken,
    });
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    const { activity } = await import("./activity-log.js");
    activity("credits.deposit_fail", { txHash, reason: message }, "warn");
    return res.status(400).json({ error: message });
  }
}
