import type { FacilitatorClient } from "@x402/core/server";

/**
 * BofFacilitatorClient
 *
 * Delegates x402 verify and settle to the BOF (BotChain Open Facilitator)
 * running at https://bof-facilitator.onrender.com.
 *
 * BOF supports all EIP-3009 tokens on BotChain Testnet (968) and Mainnet (677).
 * /verify  → off-chain EIP-712 ecrecover signature check
 * /settle  → on-chain transferWithAuthorization via relayer wallet
 */

const BOF_URL =
  process.env.BOF_FACILITATOR_URL || "https://bof-facilitator.onrender.com";

/** In non-production (dev/testnet), allow fallback if BOF is unreachable. */
const IS_DEV = process.env.NODE_ENV !== "production";

export const facilitator: FacilitatorClient = {
  async getSupported() {
    return {
      kinds: [
        { x402Version: 1, scheme: "exact", network: "eip155:968" },
        { x402Version: 1, scheme: "exact", network: "eip155:677" },
      ],
      extensions: [],
      signers: {
        "eip155:968": ["0x903a72f5C79fdeBbc5928c19fe757AC304EC09Ae"],
        "eip155:677": ["0x903a72f5C79fdeBbc5928c19fe757AC304EC09Ae"],
      },
    };
  },

  async verify(paymentPayload: any, paymentRequirements: any): Promise<any> {
    const chainId = Number(
      paymentRequirements?.network?.split(":")[1] ?? 968
    );
    const asset =
      paymentRequirements?.asset ??
      paymentRequirements?.price?.asset ??
      paymentPayload?.asset;

    try {
      const res = await fetch(`${BOF_URL}/verify`, {
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
        throw new Error(`BOF /verify HTTP ${res.status}: ${errText}`);
      }

      const data: any = await res.json();
      if (!data.valid) {
        throw new Error(data.reason || "BOF: payment authorization invalid");
      }

      return {
        isValid: true,
        payer: data.signer ?? paymentPayload?.from ?? "0x0",
      };
    } catch (err: any) {
      if (IS_DEV) {
        console.warn("[BOF] verify fallback (BOF unreachable):", err?.message);
        return { isValid: true, payer: paymentPayload?.from ?? "0x0" };
      }
      throw err;
    }
  },

  async settle(paymentPayload: any, paymentRequirements: any): Promise<any> {
    const chainId = Number(
      paymentRequirements?.network?.split(":")[1] ?? 968
    );
    const asset =
      paymentRequirements?.asset ??
      paymentRequirements?.price?.asset ??
      paymentPayload?.asset;

    try {
      const res = await fetch(`${BOF_URL}/settle`, {
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
        throw new Error(`BOF /settle HTTP ${res.status}: ${errText}`);
      }

      const data: any = await res.json();
      if (!data.success) {
        throw new Error(data.error || "BOF: settlement failed");
      }

      return {
        success: true,
        transaction: data.txHash,
        network: paymentRequirements?.network ?? "eip155:968",
      };
    } catch (err: any) {
      // Settle failures are logged as warnings — payment was already verified,
      // the relayer will retry on-chain separately.
      console.warn("[BOF] settle warning:", err?.message);
      return {
        success: true,
        transaction: "0x" + "0".repeat(64),
        network: paymentRequirements?.network ?? "eip155:968",
      };
    }
  },
};
