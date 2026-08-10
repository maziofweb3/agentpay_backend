import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { paymentMiddleware } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { x402ResourceServer, RoutesConfig } from "@x402/core/server";
import { facilitator, checkFacilitatorHealth } from "./lib/x402-facilitator.js";
import {
  getActiveModel,
  getActiveGeminiModel,
  generateChatResponse,
  enhanceImagePrompt,
  generateImageVisual,
  auditCodeSnippet,
  checkQuotaStatus,
  AIProvider,
} from "./lib/ai.js";
import {
  amountForPaidRoute,
  PAYMENT_TX_HEADER,
  verifyUsdtTransferPayment,
  consumePaymentTx,
} from "./lib/usdt-transfer-payment.js";
import { trySessionPayment } from "./lib/session-payment.js";
import { activity } from "./lib/activity-log.js";
import {
  validateTextField,
  preview,
  aiErrorStatus,
  aiErrorHint,
  cleanErrorMessage,
} from "./lib/validation.js";
import { handleCreditsDeposit } from "./lib/prepaid-ledger.js";
import { formatReputationSummary } from "./lib/erc8004.js";
import { appendAttributionTag } from "./lib/attribution.js";
import {
  getApayPriceUsd,
  calculatePromptApayWei,
} from "./lib/apay-price.js";

const app = express();

app.use(
  cors({
    origin: "*",
    methods: ["GET", "HEAD", "PUT", "POST", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-AgentPay-Payment-Tx",
      "PAYMENT-SIGNATURE",
      "X-Payment",
    ],
    exposedHeaders: [
      "Payment-Required",
      "payment-required",
      "PAYMENT-REQUIRED",
      "PAYMENT-RESPONSE",
      "X-PAYMENT-RESPONSE",
      "X-AgentPay-Charged",
      "X-AgentPay-Remaining",
      "X-AgentPay-Payment-Tx",
    ],
    maxAge: 86400,
  }),
);

// Route-aware JSON body limit:
//   /api/image — 10 MB (accepts base64-encoded image uploads up to ~7 MB)
//   all others  — 1 MB  (tight limit to prevent abuse)
const jsonParserImage = express.json({ limit: "10mb" });
const jsonParserDefault = express.json({ limit: "1mb" });

app.use((req: Request, res: Response, next: NextFunction) => {
  const url = req.originalUrl || req.url || "";
  if (url.includes("/api/image")) {
    return jsonParserImage(req, res, next);
  }
  return jsonParserDefault(req, res, next);
});

function formatApay(amount: bigint | string): string {
  try {
    const val = typeof amount === "bigint" ? amount : BigInt(amount);
    const tokens = Number(val) / 1e18;
    const formatted =
      tokens % 1 === 0
        ? tokens.toFixed(1)
        : Number.isInteger(tokens * 100)
        ? tokens.toFixed(2)
        : tokens.toFixed(4);
    return `${formatted} $APAY`;
  } catch {
    return `${amount} APAY`;
  }
}

// Request Access Logging Middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  const method = req.method;
  const url = req.originalUrl || req.url;

  res.on("finish", () => {
    // Skip health probes and CORS preflight — they add noise with zero signal
    if (!url.includes("/health") && method !== "OPTIONS") {
      activity("request.access", {
        method,
        path: url,
        status: res.statusCode,
        ms: Date.now() - start,
      });
    }
  });

  next();
});

const defaultNetwork =
  process.env.NODE_ENV === "production" || process.env.RENDER === "true"
    ? "mainnet"
    : "testnet";
const rawNetworkEnv = process.env.X402_NETWORK ?? defaultNetwork;
const rawNetwork =
  rawNetworkEnv === "mainnet" || rawNetworkEnv === "testnet"
    ? rawNetworkEnv
    : defaultNetwork;
const isMainnet = rawNetwork === "mainnet";

const botChainTestnetCaip = "eip155:968" as const;
const botChainMainnetCaip = "eip155:677" as const;
const activeBotChainCaip = isMainnet
  ? botChainMainnetCaip
  : botChainTestnetCaip;
const activeChainId = isMainnet ? 677 : 968;

const rpcUrlEnv = process.env.BOTCHAIN_RPC_URL;
if (!rpcUrlEnv)
  throw new Error("FATAL: BOTCHAIN_RPC_URL environment variable is missing");
const activeRpcUrl = rpcUrlEnv;

const apayEnv = process.env.APAY_TOKEN_ADDRESS;
if (!apayEnv)
  throw new Error("FATAL: APAY_TOKEN_ADDRESS environment variable is missing");
const apayAddress = apayEnv as `0x${string}`;

const payToEnv = process.env.PAYMENT_RECIPIENT_ADDRESS;
if (!payToEnv)
  throw new Error(
    "FATAL: PAYMENT_RECIPIENT_ADDRESS environment variable is missing",
  );
const payToAddress = payToEnv as `0x${string}`;

const server = new x402ResourceServer(facilitator);
server.register(activeBotChainCaip, new ExactEvmScheme());

const extraNetworks = (process.env.X402_EXTRA_NETWORKS ?? "")
  .split(",")
  .map((n) => n.trim())
  .filter(Boolean);
for (const network of extraNetworks) {
  server.register(network as `${string}:${string}`, new ExactEvmScheme());
}

// GET /api/price — returns current APAY token price status, single source of truth matrix, and cache info
app.get("/api/price", async (_req: Request, res: Response) => {
  const priceInfo = await getApayPriceUsd();
  return res.json({
    status: "ok",
    token: "APAY",
    ...priceInfo,
  });
});

// Health check endpoints
const healthHandler = async (_req: Request, res: Response) => {
  const [priceInfo, facilitatorHealth] = await Promise.all([
    getApayPriceUsd(),
    checkFacilitatorHealth(),
  ]);

  const isHealthy = facilitatorHealth.status === "healthy";
  return res.json({
    status: isHealthy ? "ok" : "degraded",
    service: "AgentPay AI API Gateway (Express)",
    timestamp: new Date().toISOString(),
    aiProvider: `Google ${getActiveGeminiModel()} (Default) / Anthropic ${getActiveModel()}`,
    defaultModel: getActiveGeminiModel(),
    geminiModel: getActiveGeminiModel(),
    claudeModel: getActiveModel(),
    network: activeBotChainCaip,
    chainId: activeChainId,
    apayAsset: apayAddress,
    paymentAsset: "APAY",
    paymentAssetOnly: true,
    apayPriceUsd: priceInfo.priceUsd,
    apayPriceSource: priceInfo.source,
    baseComputeUnitUsd: priceInfo.baseComputeUnitUsd,
    servicePrices: priceInfo.servicePrices,
    paymentMethods: ["prepaid-session", "x402-exact-eip3009"],
    paymentTxHeader: "X-AgentPay-Payment-Tx",
    sessionHeader: "Authorization: Bearer <sessionToken>",
    creditsDeposit: "/api/credits/deposit",
    rpcUrl: activeRpcUrl,
    supportedNetworks: [
      { name: "BotChain Testnet", caip2: botChainTestnetCaip, chainId: 968 },
      { name: "BotChain Mainnet", caip2: botChainMainnetCaip, chainId: 677 },
    ],
    relayEndpoint: "/api/botchain/relay",
    payTo: payToAddress,
    payToType: "AgentPayRegistry UUPS ERC1967 Proxy Smart Contract Vault",
    facilitator: facilitatorHealth,
  });
};

app.get("/health", healthHandler);
app.get("/api/health", healthHandler);

// Payment Gate Middleware with Single Source of Truth Dynamic Billing
app.use("/api/*", async (req: Request, res: Response, next: NextFunction) => {
  const method = req.method.toUpperCase();
  const pathname = req.baseUrl
    ? req.baseUrl.replace(/\/+$/, "") + req.path
    : req.path;
  const fullPath = pathname.startsWith("/api") ? pathname : `/api${pathname}`;

  if (method !== "POST") {
    return next();
  }

  const priceInfo = await getApayPriceUsd();
  const promptText = (req.body?.prompt ?? req.body?.code ?? req.body?.message ?? "").toString();
  const provider = (req.body?.provider ?? (req.headers["x-provider"] as string) ?? "").toString();
  const hasImage = typeof req.body?.image === "string" && req.body.image.length > 0;

  const billing = calculatePromptApayWei({
    fullPath,
    promptText,
    provider,
    hasImage,
    apayPriceUsd: priceInfo.priceUsd,
  });

  if (billing === null) {
    return next();
  }

  // ★ Pre-Flight Quota Check — reject BEFORE payment challenge if model key is out of quota
  const resolvedProvider: AIProvider = provider === "claude" ? "claude" : "gemini";
  const quotaCheck = checkQuotaStatus(resolvedProvider);
  if (quotaCheck.exceeded) {
    activity(
      "request.reject",
      { path: fullPath, provider: resolvedProvider, reason: "quota_circuit_breaker", retryInSec: quotaCheck.retryInSec },
      "warn"
    );
    return res.status(429).json({
      success: false,
      tool: fullPath,
      error: `AI provider (${resolvedProvider}) free-tier quota is currently exhausted. Please retry in ${quotaCheck.retryInSec}s or switch model provider.`,
      errorType: "rate_limit",
      hint: `Google AI Studio free-tier limit reached (20 req/day for gemini-3.6-flash). Retry in ${quotaCheck.retryInSec}s or select Claude 3.5.`,
      retryInSeconds: quotaCheck.retryInSec,
      timestamp: new Date().toISOString(),
    });
  }

  const {
    targetUsdCost,
    requiredAmount,
    requiredAmountFormatted,
    modelKey,
    modelName,
    inputTokens,
    outputTokenBudget,
    rawComputeUsd,
    profitUsd,
  } = {
    targetUsdCost: billing.totalUsd,
    requiredAmount: billing.requiredAmount,
    requiredAmountFormatted: billing.requiredAmountFormatted,
    modelKey: billing.modelKey,
    modelName: billing.modelName,
    inputTokens: billing.inputTokens,
    outputTokenBudget: billing.outputTokenBudget,
    rawComputeUsd: billing.rawComputeUsd,
    profitUsd: billing.profitUsd,
  };

  // ── Path 0: EIP-3009 x402 authorization (new single-click flow) ───────────
  const xPayment = (req.headers["x-payment"] ?? req.headers["X-Payment"]) as
    | string
    | undefined;
  if (xPayment) {
    try {
      const payload = JSON.parse(
        Buffer.from(xPayment, "base64").toString("utf8"),
      );

      // ★ Amount validation — must cover the route price
      const paymentValue = BigInt(payload.value ?? "0");
      if (paymentValue < requiredAmount) {
        const needFormatted = formatApay(requiredAmount);
        const gotFormatted = formatApay(paymentValue);
        activity(
          "payment.x402_fail",
          {
            path: fullPath,
            reason: `underpaid: got ${gotFormatted}, need ${needFormatted}`,
          },
          "warn"
        );
        return res.status(402).json({
          error: `Insufficient payment: need ${needFormatted}, got ${gotFormatted}`,
          requiredAmount: requiredAmount.toString(),
          requiredAmountFormatted: needFormatted,
          network: activeBotChainCaip,
        });
      }

      // Verify EIP-3009 signature off-chain via BOF
      await facilitator.verify(payload, {
        network: activeBotChainCaip,
        asset: apayAddress,
      } as any);
      activity("payment.x402_verified", {
        path: fullPath,
        amount: formatApay(paymentValue),
        from: String(payload.from).slice(0, 12),
      });

      // After handler flushes response, settle on-chain via BOF (non-blocking)
      res.on("finish", () => {
        if (res.statusCode >= 200 && res.statusCode < 400) {
          (
            facilitator.settle(payload, {
              network: activeBotChainCaip,
              asset: apayAddress,
            } as any) as Promise<any>
          )
            .then((r: any) =>
              activity("payment.x402_settled", {
                path: fullPath,
                amount: formatApay(paymentValue),
                tx: String(r.transaction).slice(0, 14),
              })
            )
            .catch((e: Error) =>
              activity(
                "payment.settle_fail",
                { path: fullPath, amount: formatApay(paymentValue), reason: e.message },
                "warn"
              )
            );
        }
      });

      return next();
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Payment verification failed";
      activity("payment.x402_fail", { path: fullPath, reason: msg }, "warn");
      return res.status(402).json({
        error: msg,
        paymentAsset: "APAY",
        network: activeBotChainCaip,
      });
    }
  }

  // ── Path 1: Legacy on-chain USDT transfer proof ───────────────────────────
  const txHash = (req.headers[PAYMENT_TX_HEADER.toLowerCase()] ||
    req.headers["x-agentpay-payment-tx"]) as string | undefined;
  if (txHash) {
    try {
      const result = await verifyUsdtTransferPayment({
        txHash,
        apayAddress,
        payTo: payToAddress,
        minAmountAtomic: requiredAmount,
        chainId: activeChainId,
        rpcUrl: activeRpcUrl,
      });
      activity("payment.transfer_ok", {
        path: fullPath,
        txHash: result.txHash,
        from: result.from,
        amountAtomic: result.amount.toString(),
      });

      // Hook response listener to consume tx after successful response
      res.on("finish", () => {
        if (res.statusCode >= 200 && res.statusCode < 400) {
          consumePaymentTx(result.txHash);
          activity("payment.consumed", {
            path: fullPath,
            txHash: result.txHash,
            status: res.statusCode,
          });
        } else {
          activity(
            "payment.transfer_ok",
            {
              path: fullPath,
              txHash: result.txHash,
              note: "handler_failed_tx_not_consumed",
              status: res.statusCode,
            },
            "warn",
          );
        }
      });

      return next();
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Invalid USDT payment transaction";
      activity(
        "payment.transfer_fail",
        { path: fullPath, reason: message },
        "warn",
      );
      return res.status(402).json({
        error: message,
        paymentAsset: "USDT",
        payTo: payToAddress,
        requiredAmount: requiredAmount.toString(),
        network: activeBotChainCaip,
      });
    }
  }

  // 2) Prepaid session
  const auth = req.headers["authorization"];
  if (auth) {
    try {
      const paid = trySessionPayment(auth, requiredAmount, fullPath);
      if (paid) {
        res.setHeader("X-AgentPay-Charged", paid.chargedAtomic.toString());
        res.setHeader("X-AgentPay-Remaining", paid.remainingAtomic.toString());
        return next();
      }
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Session payment failed";
      activity(
        "payment.session_fail",
        { path: fullPath, reason: message },
        "warn",
      );
    }
  }

  // 3) Fallback x402 Challenge — clean 402 response with dynamic pre-challenge token billing
  activity("payment.challenge", {
    path: fullPath,
    modelKey,
    modelName,
    inputTokens,
    outputTokenBudget,
    rawComputeUsd,
    profitUsd,
    computeCostUsd: targetUsdCost,
    apayPriceUsd: priceInfo.priceUsd,
    requiredAmount: requiredAmount.toString(),
    requiredAmountFormatted,
    network: activeBotChainCaip,
  });

  const paymentAccept = {
    accepts: [
      {
        scheme: "exact",
        network: activeBotChainCaip,
        amount: requiredAmount.toString(),
        asset: apayAddress,
        payTo: payToAddress,
        extra: { name: "AgentPay Token", version: "1" },
      },
    ],
  };

  const headerBase64 = Buffer.from(JSON.stringify(paymentAccept)).toString(
    "base64"
  );
  res.setHeader("payment-required", headerBase64);
  res.setHeader("Payment-Required", headerBase64);

  return res.status(402).json({
    error: `Payment required: ${requiredAmountFormatted}`,
    accepts: paymentAccept.accepts,
    paymentAsset: "APAY",
    requiredAmount: requiredAmount.toString(),
    requiredAmountFormatted,
    modelKey,
    modelName,
    inputTokens,
    outputTokenBudget,
    rawComputeUsd,
    profitUsd,
    totalUsd: targetUsdCost,
    computeCostUsd: targetUsdCost,
    apayPriceUsd: priceInfo.priceUsd,
    network: activeBotChainCaip,
    payTo: payToAddress,
  });
});

// Route Endpoints
app.post("/api/chat", async (req: Request, res: Response) => {
  const body = req.body || {};
  const validated = validateTextField(body.prompt, "prompt");
  if (!validated.ok) {
    activity(
      "request.reject",
      { tool: "chat", reason: validated.error },
      "warn",
    );
    return res
      .status(400)
      .json({ success: false, tool: "chat", error: validated.error });
  }
  const prompt = validated.value;
  const provider: AIProvider = body.provider === "claude" ? "claude" : "gemini";
  activity("ai.chat", {
    phase: "start",
    provider,
    promptPreview: preview(prompt),
  });

  const priceInfo = await getApayPriceUsd();
  const billing = calculatePromptApayWei({
    fullPath: "/api/chat",
    promptText: prompt,
    provider,
    apayPriceUsd: priceInfo.priceUsd,
  });

  const result = await generateChatResponse(
    prompt,
    provider,
    billing?.outputTokenBudget
  );
  if (!result.ok) {
    const status = aiErrorStatus(result.errorType);
    activity(
      "ai.error",
      {
        tool: "chat",
        errorType: result.errorType,
        status,
        details: cleanErrorMessage(result.error),
      },
      "error",
    );
    return res.status(status).json({
      success: false,
      tool: "chat",
      error:
        result.errorType === "rate_limit"
          ? "AI provider quota/rate limit exceeded (429 RESOURCE_EXHAUSTED)"
          : result.error || "AI response unavailable",
      errorType: result.errorType,
      hint: aiErrorHint(result.errorType),
      details: result.error,
      timestamp: new Date().toISOString(),
    });
  }

  activity("ai.chat", {
    phase: "ok",
    model: result.model,
    chars: result.text.length,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    truncated: result.truncated,
  });

  return res.json({
    success: true,
    tool: "chat",
    prompt,
    response: result.text,
    model: result.model,
    truncated: result.truncated,
    usage: {
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    },
    timestamp: new Date().toISOString(),
  });
});

app.post("/api/image", async (req: Request, res: Response) => {
  const body = req.body || {};

  // Vision mode: image uploaded for analysis
  const imageBase64: string | undefined =
    typeof body.image === "string" && body.image.length > 0 ? body.image : undefined;

  const rawPrompt: string = typeof body.prompt === "string" ? body.prompt.trim() : "";

  // Require at least a prompt (for text-to-image) or an image (for vision)
  if (!rawPrompt && !imageBase64) {
    return res.status(400).json({ success: false, tool: "image", error: "prompt or image is required" });
  }

  const provider: AIProvider = body.provider === "claude" ? "claude" : "gemini";
  activity("ai.image", { phase: "start", provider, hasImage: !!imageBase64, promptPreview: preview(rawPrompt) });

  // ── Vision mode: analyze the uploaded image ──────────────────────────────
  if (imageBase64) {
    const priceInfo = await getApayPriceUsd();
    const billing = calculatePromptApayWei({
      fullPath: "/api/image",
      promptText: rawPrompt || "",
      provider,
      hasImage: true,
      apayPriceUsd: priceInfo.priceUsd,
    });
    const result = await enhanceImagePrompt(
      rawPrompt || "",
      provider,
      imageBase64,
      billing?.outputTokenBudget
    );
    if (!result.ok) {
      const status = aiErrorStatus(result.errorType);
      activity("ai.error", { tool: "image", errorType: result.errorType, status, details: cleanErrorMessage(result.error) }, "error");
      return res.status(status).json({
        success: false,
        tool: "image",
        error:
          result.errorType === "rate_limit"
            ? "AI provider quota/rate limit exceeded (429 RESOURCE_EXHAUSTED)"
            : result.error || "Image vision analysis unavailable",
        errorType: result.errorType,
        hint: aiErrorHint(result.errorType),
        details: result.error,
        timestamp: new Date().toISOString(),
      });
    }
    activity("ai.image", { phase: "vision_ok", chars: result.text.length });
    return res.json({
      success: true,
      tool: "image",
      mode: "vision",
      rawPrompt,
      analysis: result.text,
      model: result.model,
      usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens },
      timestamp: new Date().toISOString(),
    });
  }

  // ── Text-to-Image mode ────────────────────────────────────────────────────
  // Step 1: Enhance the prompt
  const validated = validateTextField(rawPrompt, "prompt");
  if (!validated.ok) {
    activity("request.reject", { tool: "image", reason: validated.error }, "warn");
    return res.status(400).json({ success: false, tool: "image", error: validated.error });
  }

  const enhanceResult = await enhanceImagePrompt(validated.value, provider);
  if (!enhanceResult.ok) {
    const status = aiErrorStatus(enhanceResult.errorType);
    activity("ai.error", { tool: "image", errorType: enhanceResult.errorType, status, details: cleanErrorMessage(enhanceResult.error) }, "error");
    return res.status(status).json({
      success: false,
      tool: "image",
      error:
        enhanceResult.errorType === "rate_limit"
          ? "AI provider quota/rate limit exceeded (429 RESOURCE_EXHAUSTED)"
          : enhanceResult.error || "Image prompt enhancement unavailable",
      errorType: enhanceResult.errorType,
      hint: aiErrorHint(enhanceResult.errorType),
      details: enhanceResult.error,
      timestamp: new Date().toISOString(),
    });
  }

  // Step 2: Generate image with Imagen 3
  const imageResult = await generateImageVisual(enhanceResult.text);
  if (!imageResult.ok) {
    // Fallback: return enhanced prompt text and a placeholder if Imagen fails
    activity("ai.image", { phase: "imagen_failed_fallback", reason: imageResult.error }, "warn");
    return res.json({
      success: true,
      tool: "image",
      mode: "text-to-image",
      rawPrompt: validated.value,
      enhancedPrompt: enhanceResult.text,
      imageUrl: `https://placehold.co/512x512/0f172a/f59e0b?text=${encodeURIComponent(validated.value)}`,
      imageFallback: true,
      model: enhanceResult.model,
      usage: { inputTokens: enhanceResult.inputTokens, outputTokens: enhanceResult.outputTokens },
      timestamp: new Date().toISOString(),
    });
  }

  activity("ai.image", { phase: "ok", mode: "text-to-image" });
  return res.json({
    success: true,
    tool: "image",
    mode: "text-to-image",
    rawPrompt: validated.value,
    enhancedPrompt: enhanceResult.text,
    imageUrl: imageResult.imageDataUri,
    model: enhanceResult.model,
    usage: { inputTokens: enhanceResult.inputTokens, outputTokens: enhanceResult.outputTokens },
    timestamp: new Date().toISOString(),
  });
});

app.post("/api/code", async (req: Request, res: Response) => {
  const body = req.body || {};
  const validated = validateTextField(body.code, "code");
  if (!validated.ok) {
    activity(
      "request.reject",
      { tool: "code", reason: validated.error },
      "warn",
    );
    return res
      .status(400)
      .json({ success: false, tool: "code", error: validated.error });
  }
  const code = validated.value;
  const provider: AIProvider = body.provider === "claude" ? "claude" : "gemini";
  activity("ai.code", { phase: "start", provider, codePreview: preview(code) });

  const priceInfo = await getApayPriceUsd();
  const billing = calculatePromptApayWei({
    fullPath: "/api/code",
    promptText: code,
    provider,
    apayPriceUsd: priceInfo.priceUsd,
  });

  const result = await auditCodeSnippet(
    code,
    provider,
    billing?.outputTokenBudget
  );
  if (!result.ok) {
    const status = aiErrorStatus(result.errorType);
    activity(
      "ai.error",
      {
        tool: "code",
        errorType: result.errorType,
        status,
        details: cleanErrorMessage(result.error),
      },
      "error",
    );
    return res.status(status).json({
      success: false,
      tool: "code",
      error:
        result.errorType === "rate_limit"
          ? "AI provider quota/rate limit exceeded (429 RESOURCE_EXHAUSTED)"
          : result.error || "Code audit unavailable — no verdict was produced",
      errorType: result.errorType,
      hint: aiErrorHint(result.errorType),
      details: result.error,
      timestamp: new Date().toISOString(),
    });
  }

  activity("ai.code", {
    phase: "ok",
    score: result.audit.score,
    vulnerabilities: result.audit.vulnerabilities,
  });
  return res.json({
    success: true,
    tool: "code",
    audit: result.audit,
    model: result.model,
    timestamp: new Date().toISOString(),
  });
});

app.post("/api/reputation", async (req: Request, res: Response) => {
  const body = req.body || {};
  const agentAddress =
    typeof body.agentAddress === "string" ? body.agentAddress : undefined;
  const formatted = formatReputationSummary(85, 12);
  return res.json({
    success: true,
    tool: "reputation",
    agentAddress: agentAddress ?? null,
    reputation: formatted,
    timestamp: new Date().toISOString(),
  });
});

app.post("/api/attribution", async (req: Request, res: Response) => {
  const body = req.body || {};
  const data = typeof body.data === "string" ? body.data : "0x";
  const taggedData = appendAttributionTag(data);
  return res.json({
    success: true,
    tool: "attribution",
    originalData: data,
    taggedData,
    attributionTag: "0x8021",
    timestamp: new Date().toISOString(),
  });
});

app.post("/api/credits/deposit", async (req: Request, res: Response) => {
  return handleCreditsDeposit(req, res, {
    usdtAddress: apayAddress,
    payTo: payToAddress,
    chainId: activeChainId,
    rpcUrl: activeRpcUrl,
    network: activeBotChainCaip,
  });
});

export { app };
export default app;
