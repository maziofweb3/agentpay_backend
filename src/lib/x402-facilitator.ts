import { config } from "dotenv";
import type { FacilitatorClient } from "@x402/core/server";
import { activity } from "./activity-log.js";

config({ path: ".env.local" });
config({ path: ".env" });

/**
 * BofFacilitatorClient
 *
 * Delegates x402 verify and settle to the BOF (BotChain Open Facilitator).
 * Requires BOF_FACILITATOR_URL environment variable to be explicitly configured.
 *
 * BOF supports all EIP-3009 tokens on BotChain Testnet (968) and Mainnet (677).
 * /verify  → off-chain EIP-712 ecrecover signature check
 * /settle  → on-chain transferWithAuthorization via relayer wallet
 */

function getBofUrl(): string {
  const url = process.env.BOF_FACILITATOR_URL;
  if (!url) {
    throw new Error("FATAL: BOF_FACILITATOR_URL environment variable is missing");
  }
  return url.replace(/\/+$/, "");
}

export const facilitator: FacilitatorClient = {
  async getSupported() {
    return {
      kinds: [
        { x402Version: 1, scheme: "exact", network: "eip155:968" },
        { x402Version: 2, scheme: "exact", network: "eip155:968" },
        { x402Version: 1, scheme: "exact", network: "eip155:677" },
        { x402Version: 2, scheme: "exact", network: "eip155:677" },
      ],
      extensions: [],
      signers: {
        "eip155:968": ["0x903a72f5C79fdeBbc5928c19fe757AC304EC09Ae"],
        "eip155:677": ["0x903a72f5C79fdeBbc5928c19fe757AC304EC09Ae"],
      },
    };
  },

  async verify(paymentPayload: any, paymentRequirements: any): Promise<any> {
    const bofUrl = getBofUrl();
    const chainId = Number(
      paymentRequirements?.network?.split(":")[1] ?? 968
    );
    const asset =
      paymentRequirements?.asset ??
      paymentRequirements?.price?.asset ??
      paymentPayload?.asset;

    activity("payment.x402_verified", {
      phase: "contacting_bof",
      endpoint: `${bofUrl}/verify`,
      chainId,
      asset,
    });

    const res = await fetch(`${bofUrl}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scheme: "ExactEvmScheme",
        chainId,
        asset,
        payload: paymentPayload,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      activity("payment.x402_fail", { reason: `HTTP ${res.status}: ${errText}` }, "error");
      throw new Error(`BOF /verify HTTP ${res.status}: ${errText}`);
    }

    const data: any = await res.json();
    if (!data.valid) {
      activity("payment.x402_fail", { reason: data.reason || "BOF authorization invalid" }, "error");
      throw new Error(data.reason || "BOF: payment authorization invalid");
    }

    return {
      isValid: true,
      payer: data.signer ?? paymentPayload?.from ?? "0x0",
    };
  },

  async settle(paymentPayload: any, paymentRequirements: any): Promise<any> {
    const bofUrl = getBofUrl();
    const chainId = Number(
      paymentRequirements?.network?.split(":")[1] ?? 968
    );
    const asset =
      paymentRequirements?.asset ??
      paymentRequirements?.price?.asset ??
      paymentPayload?.asset;

    activity("payment.x402_settled", {
      phase: "contacting_bof",
      endpoint: `${bofUrl}/settle`,
      chainId,
      asset,
    });

    const res = await fetch(`${bofUrl}/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scheme: "ExactEvmScheme",
        chainId,
        asset,
        payload: paymentPayload,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      activity("payment.settle_fail", { reason: `HTTP ${res.status}: ${errText}` }, "error");
      throw new Error(`BOF /settle HTTP ${res.status}: ${errText}`);
    }

    const data: any = await res.json();
    if (!data.success) {
      activity("payment.settle_fail", { reason: data.error || "BOF settlement failed" }, "error");
      throw new Error(data.error || "BOF: settlement failed");
    }

    return {
      success: true,
      transaction: data.txHash,
      network: paymentRequirements?.network ?? "eip155:968",
    };
  },
};
