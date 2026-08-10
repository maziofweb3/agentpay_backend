/**
 * 50% Profit Margin Markup (+50%).
 * Total Charge USD = Raw Compute USD * (1 + PROFIT_MARGIN_PCT)
 */
export const PROFIT_MARGIN_PCT = 0.50;
export const PROFIT_MARGIN_MULTIPLIER = 1.50;

export interface ModelRateCard {
  name: string;
  inMTokUsd: number;  // Cost per 1,000,000 input tokens in USD
  outMTokUsd: number; // Cost per 1,000,000 output tokens in USD
  perItemUsd?: number;
}

/**
 * Official Model Pricing Registry (Anthropic & Google Gemini AI Studio rate cards).
 */
export const MODEL_RATES: Record<string, ModelRateCard> = {
  "gemini-3.6-flash": {
    name: "Google Gemini 3.6 Flash",
    inMTokUsd: 1.50,
    outMTokUsd: 7.50,
  },
  "gemini-3.5-flash": {
    name: "Google Gemini 3.5 Flash",
    inMTokUsd: 1.50,
    outMTokUsd: 9.00,
  },
  "gemini-2.5-flash": {
    name: "Google Gemini 2.5 Flash",
    inMTokUsd: 0.30,
    outMTokUsd: 2.50,
  },
  "claude-3-5-sonnet": {
    name: "Anthropic Claude 3.5 Sonnet",
    inMTokUsd: 3.00,
    outMTokUsd: 15.00,
  },
  "claude-sonnet-5": {
    name: "Anthropic Claude Sonnet 5",
    inMTokUsd: 3.00,
    outMTokUsd: 15.00,
  },
  "claude-haiku-4.5": {
    name: "Anthropic Claude Haiku 4.5",
    inMTokUsd: 1.00,
    outMTokUsd: 5.00,
  },
  "claude-opus-5": {
    name: "Anthropic Claude Opus 5",
    inMTokUsd: 5.00,
    outMTokUsd: 25.00,
  },
  "imagen-3": {
    name: "AI Image Generation",
    inMTokUsd: 0,
    outMTokUsd: 0,
    perItemUsd: 0.0390,
  },
};

export type ServiceType = "chat" | "relay" | "code" | "image";

export const OUTPUT_BUDGET_CONFIG: Record<
  ServiceType,
  { ratio: number; min: number; max: number }
> = {
  chat: { ratio: 2.0, min: 512, max: 1536 },
  relay: { ratio: 2.0, min: 512, max: 1536 },
  code: { ratio: 3.0, min: 800, max: 2048 },
  image: { ratio: 1.5, min: 600, max: 1536 },
} as const;

export interface IntentClassification {
  category: "direct_fact" | "explanation" | "code_complex" | "general";
  budget: number;
}

export function classifyPromptIntent(
  prompt: string,
  fullPath: string = "/api/chat"
): IntentClassification {
  const normPath = fullPath.replace(/\/+$/, "") || "/";
  const p = prompt.toLowerCase().trim();

  // 1. Code / Smart Contract / Security Audit Route & Queries (Tier 3) -> 1,536 tokens (2.0x)
  if (
    normPath === "/api/code" ||
    /audit|solidity|contract|refactor|vulnerability|bytecode|reentrancy/i.test(p)
  ) {
    return { category: "code_complex", budget: 1536 };
  }

  // 2. Open-Ended Concept Explanation / Summarization / Deep Dive (Tier 2) -> 1,024 tokens (2.0x)
  if (
    /^(explain|describe|overview|how\s+does|how\s+do|why\s+does|why\s+do|history\s+of|compare|difference\s+between|tell\s+me\s+about|what\s+is\s+a)\s/i.test(p) ||
    p.length > 120
  ) {
    return { category: "explanation", budget: 1024 };
  }

  // 3. Direct Factual Q&A (Tier 1) -> 512 tokens (2.0x)
  if (
    /^(who|what|when|where|is|was|are|can|does|did|name)\s/i.test(p) &&
    p.length < 80
  ) {
    return { category: "direct_fact", budget: 512 };
  }

  // 4. Default Fallback -> 768 tokens (2.0x)
  return { category: "general", budget: 768 };
}

export function calculateOutputBudget(
  inputTokens: number,
  serviceType: ServiceType,
  promptStr?: string,
  fullPath?: string
): number {
  const cfg = OUTPUT_BUDGET_CONFIG[serviceType];
  if (!cfg) return 256;

  let baseBudget = cfg.min;
  if (promptStr) {
    const intent = classifyPromptIntent(promptStr, fullPath ?? "/api/chat");
    baseBudget = Math.max(cfg.min, intent.budget);
  }

  const dynamic = Math.max(baseBudget, Math.ceil(inputTokens * cfg.ratio));
  return Math.min(dynamic, cfg.max);
}

/**
 * Default Benchmark Single Source of Truth Base Compute Unit Cost in USD ($0.0078).
 */
export const BASE_COMPUTE_UNIT_USD = 0.0078;

export const SERVICE_MULTIPLIERS = {
  chat: 1.0,   // $0.0078 USD benchmark
  relay: 1.0,  // $0.0078 USD benchmark
  code: 2.0,   // $0.0156 USD benchmark
  image: 5.0,  // $0.0390 USD benchmark
} as const;

export interface ApayPriceInfo {
  priceUsd: number;
  updatedAt: number;
  ttlSec: number;
  source: "api" | "development_fallback";
  baseComputeUnitUsd: number;
  profitMarginPct: number;
  modelRates: typeof MODEL_RATES;
  servicePrices: Record<
    keyof typeof SERVICE_MULTIPLIERS,
    {
      targetUsdCost: number;
      multiplier: number;
      amountTokens: number;
      amountAtomic: string;
    }
  >;
}

let cachedPriceInfo: ApayPriceInfo | null = null;

function getFallbackPriceUsd(): number {
  const envVal = process.env.APAY_PRICE_FALLBACK_USD;
  const parsed = envVal ? parseFloat(envVal) : 0.0078;
  return isNaN(parsed) || parsed <= 0 ? 0.0078 : parsed;
}

export function getAllServicePrices(apayPriceUsd: number) {
  const price = apayPriceUsd > 0 ? apayPriceUsd : getFallbackPriceUsd();
  return {
    chat: calculateServiceDetail(SERVICE_MULTIPLIERS.chat, price),
    relay: calculateServiceDetail(SERVICE_MULTIPLIERS.relay, price),
    code: calculateServiceDetail(SERVICE_MULTIPLIERS.code, price),
    image: calculateServiceDetail(SERVICE_MULTIPLIERS.image, price),
  };
}

function calculateServiceDetail(multiplier: number, apayPriceUsd: number) {
  const targetUsdCost = BASE_COMPUTE_UNIT_USD * multiplier;
  const amountTokens = targetUsdCost / apayPriceUsd;
  const amountAtomic = BigInt(Math.floor(amountTokens * 1e18)).toString();
  return {
    targetUsdCost,
    multiplier,
    amountTokens,
    amountAtomic,
  };
}

export async function getApayPriceUsd(): Promise<ApayPriceInfo> {
  const ttlSec = parseInt(process.env.APAY_PRICE_CACHE_TTL_SEC ?? "3600", 10);
  const fallbackPrice = getFallbackPriceUsd();
  const now = Date.now();

  if (cachedPriceInfo && now - cachedPriceInfo.updatedAt < ttlSec * 1000) {
    return cachedPriceInfo;
  }

  let priceUsd = fallbackPrice;
  let source: "api" | "development_fallback" = "development_fallback";

  const apiUrl = (process.env.APAY_PRICE_API_URL ?? "").trim();
  if (apiUrl) {
    try {
      const res = await fetch(apiUrl);
      if (res.ok) {
        const data = (await res.json()) as any;
        const rawVal =
          typeof data === "number" || typeof data === "string"
            ? data
            : data?.data?.price ??
              data?.data?.priceUsd ??
              data?.price ??
              data?.priceUsd ??
              data?.usd ??
              data?.["agent-pay"]?.usd ??
              data?.["agentpay"]?.usd;

        const parsedVal = typeof rawVal === "number" ? rawVal : parseFloat(String(rawVal ?? ""));
        if (!isNaN(parsedVal) && parsedVal > 0) {
          priceUsd = parsedVal;
          source = "api";
        }
      }
    } catch (e) {
      console.warn(
        "[apay-price] Failed to fetch price from APAY_PRICE_API_URL, using fallback:",
        e
      );
    }
  }

  cachedPriceInfo = {
    priceUsd,
    updatedAt: now,
    ttlSec,
    source,
    baseComputeUnitUsd: BASE_COMPUTE_UNIT_USD,
    profitMarginPct: PROFIT_MARGIN_PCT,
    modelRates: MODEL_RATES,
    servicePrices: getAllServicePrices(priceUsd),
  };

  return cachedPriceInfo;
}

export interface PromptTokenBillingInput {
  fullPath: string;
  promptText?: string;
  provider?: string;
  modelKey?: string;
  hasImage?: boolean;
  apayPriceUsd: number;
}

export interface PromptTokenBillingResult {
  modelKey: string;
  modelName: string;
  inputTokens: number;
  outputTokenBudget: number;
  rawComputeUsd: number;
  profitUsd: number;
  totalUsd: number;
  requiredAmount: bigint;
  requiredAmountFormatted: string;
  apayTokens: number;
}

/**
 * Helper to format APAY token amounts cleanly up to 4 decimal places.
 */
export function formatApayTokens(tokens: number): string {
  const formatted =
    tokens % 1 === 0
      ? tokens.toFixed(1)
      : Number.isInteger(tokens * 100)
      ? tokens.toFixed(2)
      : tokens.toFixed(4);
  return `${formatted} $APAY`;
}

/**
 * Calculates pre-challenge token-exact billing:
 * 1. Counts prompt input tokens (~1 token per 4 chars).
 * 2. Uses expected output token budget.
 * 3. Applies official model rate card.
 * 4. Adds 50% profit margin (+50%).
 * 5. Converts to required APAY wei based on live token price.
 */
export function calculatePromptApayWei(
  input: PromptTokenBillingInput
): PromptTokenBillingResult | null {
  const normPath = input.fullPath.replace(/\/+$/, "") || "/";
  const promptStr = (input.promptText ?? "").trim();
  const providerClean = (input.provider ?? "").toLowerCase().trim();
  const priceUsd = input.apayPriceUsd > 0 ? input.apayPriceUsd : getFallbackPriceUsd();

  const inputTokens = Math.max(1, Math.ceil(promptStr.length / 4));

  let selectedModelKey = input.modelKey ?? "";
  let serviceType: ServiceType | null = null;
  let isImagen = false;

  if (normPath === "/api/chat") {
    selectedModelKey = providerClean === "claude" ? "claude-3-5-sonnet" : "gemini-3.6-flash";
    serviceType = "chat";
  } else if (normPath === "/api/code") {
    selectedModelKey = "claude-3-5-sonnet";
    serviceType = "code";
  } else if (normPath === "/api/image") {
    if (input.hasImage) {
      selectedModelKey = providerClean === "claude" ? "claude-3-5-sonnet" : "gemini-3.6-flash";
      serviceType = "image";
    } else {
      selectedModelKey = "imagen-3";
      isImagen = true;
    }
  } else if (normPath === "/api/relay" || normPath === "/api/botchain/relay") {
    selectedModelKey = "gemini-3.6-flash";
    serviceType = "relay";
  } else {
    return null;
  }

  const outputTokenBudget = isImagen
    ? 0
    : serviceType
    ? calculateOutputBudget(inputTokens, serviceType, promptStr, normPath)
    : 256;

  const rateCard = MODEL_RATES[selectedModelKey] ?? MODEL_RATES["gemini-3.6-flash"];

  let rawComputeUsd = 0;
  if (rateCard.perItemUsd) {
    rawComputeUsd = rateCard.perItemUsd;
  } else {
    const inputCost = (inputTokens * rateCard.inMTokUsd) / 1000000;
    const outputCost = (outputTokenBudget * rateCard.outMTokUsd) / 1000000;
    rawComputeUsd = inputCost + outputCost;
  }

  const totalUsd = rawComputeUsd * PROFIT_MARGIN_MULTIPLIER;
  const profitUsd = totalUsd - rawComputeUsd;

  const apayTokens = totalUsd / priceUsd;
  const requiredAmount = BigInt(Math.floor(apayTokens * 1e18));
  const requiredAmountFormatted = formatApayTokens(apayTokens);

  return {
    modelKey: selectedModelKey,
    modelName: rateCard.name,
    inputTokens,
    outputTokenBudget,
    rawComputeUsd,
    profitUsd,
    totalUsd,
    requiredAmount,
    requiredAmountFormatted,
    apayTokens,
  };
}

export function calculateRouteApayWei(
  fullPath: string,
  apayPriceUsd: number
): { targetUsdCost: number; requiredAmount: bigint; multiplier: number } | null {
  const res = calculatePromptApayWei({
    fullPath,
    promptText: "",
    apayPriceUsd,
  });
  if (!res) return null;
  return {
    targetUsdCost: res.totalUsd,
    requiredAmount: res.requiredAmount,
    multiplier: 1.0,
  };
}
