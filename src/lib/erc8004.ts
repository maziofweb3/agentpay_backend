import { createPublicClient, http } from "viem";
import { celo, celoSepolia } from "viem/chains";

export const ERC8004_REGISTRIES = {
  mainnet: {
    identity: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as `0x${string}`,
    reputation: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63" as `0x${string}`,
  },
  sepolia: {
    identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e" as `0x${string}`,
    reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713" as `0x${string}`,
  },
};

export interface AgentMetadata {
  type: "Agent";
  name: string;
  description: string;
  image: string;
  endpoints: Array<{
    type: string;
    url?: string;
    address?: string;
    chainId?: number;
  }>;
  supportedTrust: string[];
  version: string;
}

export function getAgentPayMetadata(): AgentMetadata {
  return {
    type: "Agent",
    name: "AgentPay AI",
    description: "Mobile-first pay-per-prompt AI assistant on Celo MiniPay powered by Google Gemini Flash and x402 micropayments.",
    image: "https://agentpay-ai.vercel.app/icon.png",
    endpoints: [
      { type: "a2a", url: "https://agentpay-ai.vercel.app/api" },
      { type: "x402", url: "https://agentpay-ai.vercel.app/api/chat" },
      {
        type: "wallet",
        address: "0x199A6E94191d4e0ebB7DE602C5E78a83F204E6C3",
        chainId: 42220,
      },
    ],
    supportedTrust: ["reputation", "validation"],
    version: "1.0.0",
  };
}

export function validateAgentMetadata(data: any): boolean {
  if (!data || data.type !== "Agent") return false;
  if (!data.name || typeof data.name !== "string") return false;
  if (!Array.isArray(data.endpoints) || data.endpoints.length === 0) return false;
  if (!Array.isArray(data.supportedTrust)) return false;
  return true;
}

export function formatReputationSummary(score: number, totalReviews: number) {
  const percentage = Math.min(100, Math.max(0, score));
  return {
    score: percentage,
    totalReviews,
    ratingText: `${percentage}/100`,
    isVerified: percentage >= 70,
  };
}
