/**
 * BotChain-native USDT payment verification.
 *
 * BotChain USDT does not implement EIP-3009 (transferWithAuthorization), so the
 * standard x402 ExactEvmScheme cannot settle on-chain. Instead the client sends
 * a real ERC-20 `transfer` to the vault and retries the API call with
 * `X-AgentPay-Payment-Tx: <txHash>`. This module validates that transfer.
 */

import {
  createPublicClient,
  decodeEventLog,
  http,
  parseAbiItem,
  type Hash,
  type Hex,
  type Log,
} from "viem";

export const PAYMENT_TX_HEADER = "x-agentpay-payment-tx";

const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)"
);

/** Prevent the same tx from unlocking multiple paid requests. */
const spentTxHashes = new Set<string>();
const MAX_SPENT = 10_000;

export interface PaidRoutePrice {
  amountAtomic: bigint;
  path: string;
}

export interface VerifyTransferParams {
  txHash: string;
  usdtAddress: `0x${string}`;
  payTo: `0x${string}`;
  minAmountAtomic: bigint;
  chainId: number;
  rpcUrl: string;
}

export interface VerifyTransferResult {
  from: `0x${string}`;
  to: `0x${string}`;
  amount: bigint;
  txHash: Hash;
}

function normalizeTxHash(raw: string): Hash {
  const h = raw.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(h)) {
    throw new Error(`Invalid payment transaction hash: ${raw}`);
  }
  return h as Hash;
}

function markSpent(txHash: string): void {
  if (spentTxHashes.size >= MAX_SPENT) {
    // Drop an arbitrary old entry (Set iteration order is insertion order).
    const first = spentTxHashes.values().next().value;
    if (first) spentTxHashes.delete(first);
  }
  spentTxHashes.add(txHash.toLowerCase());
}

/** Test helper — clear spent set. */
export function _resetSpentTxHashesForTests(): void {
  spentTxHashes.clear();
}

/**
 * Verify an on-chain USDT transfer pays at least `minAmountAtomic` to `payTo`.
 * Throws a user-facing Error on failure.
 *
 * Does NOT mark the tx as spent — call `consumePaymentTx` only after the
 * paid handler returns success. Otherwise a timed-out AI call burns a valid
 * payment and retries return 402 "already used".
 */
export async function verifyUsdtTransferPayment(
  params: VerifyTransferParams
): Promise<VerifyTransferResult> {
  const txHash = normalizeTxHash(params.txHash);

  if (spentTxHashes.has(txHash)) {
    throw new Error("This payment transaction was already used.");
  }

  const client = createPublicClient({
    transport: http(params.rpcUrl),
  });

  // Confirm we are talking to the expected chain.
  const chainId = await client.getChainId();
  if (chainId !== params.chainId) {
    throw new Error(
      `RPC chain mismatch: expected ${params.chainId}, got ${chainId}.`
    );
  }

  const receipt = await client.getTransactionReceipt({ hash: txHash });
  if (!receipt) {
    throw new Error("Payment transaction not found. Wait for confirmation and retry.");
  }
  if (receipt.status !== "success") {
    throw new Error("Payment transaction failed on-chain.");
  }

  const usdt = params.usdtAddress.toLowerCase();
  const payTo = params.payTo.toLowerCase();

  let totalToVault = BigInt(0);
  let from: `0x${string}` | null = null;

  for (const log of receipt.logs as Log[]) {
    if ((log.address ?? "").toLowerCase() !== usdt) continue;
    try {
      const decoded = decodeEventLog({
        abi: [transferEvent],
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName !== "Transfer") continue;
      const args = decoded.args as { from: Hex; to: Hex; value: bigint };
      if (args.to.toLowerCase() !== payTo) continue;
      totalToVault += args.value;
      from = args.from as `0x${string}`;
    } catch {
      // Not a Transfer log — ignore.
    }
  }

  if (totalToVault < params.minAmountAtomic) {
    throw new Error(
      `Insufficient USDT paid. Need ${params.minAmountAtomic.toString()} atomic units, ` +
        `found ${totalToVault.toString()} to vault ${params.payTo}.`
    );
  }

  return {
    from: from ?? ("0x0000000000000000000000000000000000000000" as `0x${string}`),
    to: params.payTo,
    amount: totalToVault,
    txHash,
  };
}

/** Mark a verified payment tx as consumed after a successful paid response. */
export function consumePaymentTx(txHash: string): void {
  markSpent(normalizeTxHash(txHash));
}

/** Map request method+path to the required atomic USDT amount. */
export function amountForPaidRoute(
  method: string,
  pathname: string,
  prices: Record<string, string>
): bigint | null {
  // Normalize trailing slashes.
  const path = pathname.replace(/\/+$/, "") || "/";
  const key = `${method.toUpperCase()} ${path}`;
  const amount = prices[key];
  if (!amount) return null;
  return BigInt(amount);
}
