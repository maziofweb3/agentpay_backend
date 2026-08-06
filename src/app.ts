import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { paymentMiddleware } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { x402ResourceServer, RoutesConfig } from "@x402/core/server";
import { facilitator } from "./lib/x402-facilitator.js";
import { getActiveModel, generateChatResponse, enhanceImagePrompt, auditCodeSnippet } from "./lib/ai.js";
import {
  amountForPaidRoute,
  PAYMENT_TX_HEADER,
  verifyUsdtTransferPayment,
  consumePaymentTx,
} from "./lib/usdt-transfer-payment.js";
import { trySessionPayment } from "./lib/session-payment.js";
import { activity } from "./lib/activity-log.js";
import { validateTextField, preview, aiErrorStatus, aiErrorHint } from "./lib/validation.js";
import { handleCreditsDeposit } from "./lib/prepaid-ledger.js";
import { formatReputationSummary } from "./lib/erc8004.js";
import { appendAttributionTag } from "./lib/attribution.js";

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
      "X-PAYMENT",
      "X-PAYMENT-RESPONSE",
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
  })
);

app.use(express.json());

// Request Access Logging Middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  const method = req.method;
  const url = req.originalUrl || req.url;
  
  res.on("finish", () => {
    const durationMs = Date.now() - start;
    activity("request.access", {
      method,
      path: url,
      status: res.statusCode,
      durationMs,
      ip: (req.headers["x-forwarded-for"] as string)?.split(",")[0] || req.socket?.remoteAddress || null,
      userAgent: req.headers["user-agent"] || null,
    });
  });

  next();
});

const rawNetworkEnv = process.env.X402_NETWORK ?? "testnet";
const rawNetwork = rawNetworkEnv === "mainnet" || rawNetworkEnv === "testnet" ? rawNetworkEnv : "testnet";
const isMainnet = rawNetwork === "mainnet";

const botChainTestnetCaip = "eip155:968" as const;
const botChainMainnetCaip = "eip155:677" as const;
const activeBotChainCaip = isMainnet ? botChainMainnetCaip : botChainTestnetCaip;
const activeChainId = isMainnet ? 677 : 968;
const activeRpcUrl = isMainnet
  ? process.env.BOTCHAIN_RPC_URL || "https://rpc.botchain.ai"
  : process.env.BOTCHAIN_RPC_URL || "https://rpc.bohr.life";

const apayAddress = (
  process.env.APAY_TOKEN_ADDRESS ||
  (isMainnet
    ? "0x6A96C2755E8D88b1b369C9F3C6415B17B03eA44E"
    : "0xFd7bF688d5a772A81DfE39da502F69FD99cE92c7")
) as `0x${string}`;

const defaultProxyVaultAddress = "0xc1eBB154EFf9bf9c08e39978E1447cC05e726dC6" as `0x${string}`;
const payToAddress = (process.env.PAYMENT_RECIPIENT_ADDRESS as `0x${string}`) || defaultProxyVaultAddress;

const server = new x402ResourceServer(facilitator);
server.register(activeBotChainCaip, new ExactEvmScheme());

const extraNetworks = (process.env.X402_EXTRA_NETWORKS ?? "")
  .split(",")
  .map((n) => n.trim())
  .filter(Boolean);
for (const network of extraNetworks) {
  server.register(network as `${string}:${string}`, new ExactEvmScheme());
}

const routePrices: Record<string, string> = {
  "POST /api/chat": "1000000000000000000", // 1.0 APAY
  "POST /api/image": "5000000000000000000", // 5.0 APAY
  "POST /api/code": "2000000000000000000", // 2.0 APAY
  "POST /api/botchain/relay": "1000000000000000000", // 1.0 APAY
};

const routes: RoutesConfig = {
  "POST /api/chat": {
    accepts: {
      scheme: "exact",
      network: activeBotChainCaip,
      payTo: payToAddress,
      price: {
        amount: routePrices["POST /api/chat"],
        asset: apayAddress,
        extra: { name: "AgentPay Token", version: "1" },
      },
    },
    description: "Claude AI Chat Prompt (1.0 $APAY)",
  },
  "POST /api/image": {
    accepts: {
      scheme: "exact",
      network: activeBotChainCaip,
      payTo: payToAddress,
      price: {
        amount: routePrices["POST /api/image"],
        asset: apayAddress,
        extra: { name: "AgentPay Token", version: "1" },
      },
    },
    description: "AI Image Generation (5.0 $APAY)",
  },
  "POST /api/code": {
    accepts: {
      scheme: "exact",
      network: activeBotChainCaip,
      payTo: payToAddress,
      price: {
        amount: routePrices["POST /api/code"],
        asset: apayAddress,
        extra: { name: "AgentPay Token", version: "1" },
      },
    },
    description: "AI Code Security & Audit (2.0 $APAY)",
  },
  "POST /api/botchain/relay": {
    accepts: {
      scheme: "exact",
      network: activeBotChainCaip,
      payTo: payToAddress,
      price: {
        amount: routePrices["POST /api/botchain/relay"],
        asset: apayAddress,
        extra: { name: "AgentPay Token", version: "1" },
      },
    },
    description: "BotChain Autonomous Agent Programmatic Relay (1.0 $APAY)",
  },
};

const x402Payment = paymentMiddleware(routes, server);

// Health check endpoints
const healthHandler = (_req: Request, res: Response) => {
  return res.json({
    status: "ok",
    service: "AgentPay AI API Gateway (Express)",
    timestamp: new Date().toISOString(),
    aiProvider: `Anthropic ${getActiveModel()}`,
    model: getActiveModel(),
    network: activeBotChainCaip,
    chainId: activeChainId,
    apayAsset: apayAddress,
    paymentAsset: "APAY",
    paymentAssetOnly: true,
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
  });
};

app.get("/health", healthHandler);
app.get("/api/health", healthHandler);

// Payment Gate Middleware
app.use("/api/*", async (req: Request, res: Response, next: NextFunction) => {
  const method = req.method.toUpperCase();
  const pathname = req.baseUrl ? req.baseUrl.replace(/\/+$/, "") + req.path : req.path;
  const fullPath = pathname.startsWith("/api") ? pathname : `/api${pathname}`;
  const requiredAmount = amountForPaidRoute(method, fullPath, routePrices);

  if (requiredAmount === null) {
    return next();
  }

  // 1) One-shot on-chain USDT transfer proof
  const txHash = (req.headers[PAYMENT_TX_HEADER.toLowerCase()] || req.headers["x-agentpay-payment-tx"]) as string | undefined;
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
          activity("payment.consumed", { path: fullPath, txHash: result.txHash, status: res.statusCode });
        } else {
          activity("payment.transfer_ok", { path: fullPath, txHash: result.txHash, note: "handler_failed_tx_not_consumed", status: res.statusCode }, "warn");
        }
      });

      return next();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Invalid USDT payment transaction";
      activity("payment.transfer_fail", { path: fullPath, reason: message }, "warn");
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
      const message = err instanceof Error ? err.message : "Session payment failed";
      activity("payment.session_fail", { path: fullPath, reason: message }, "warn");
    }
  }

  // 3) Fallback x402 Challenge
  activity("payment.challenge", {
    path: fullPath,
    requiredAmount: requiredAmount.toString(),
    network: activeBotChainCaip,
  });
  return x402Payment(req, res, next);
});

// Route Endpoints
app.post("/api/chat", async (req: Request, res: Response) => {
  const body = req.body || {};
  const validated = validateTextField(body.prompt, "prompt");
  if (!validated.ok) {
    activity("request.reject", { tool: "chat", reason: validated.error }, "warn");
    return res.status(400).json({ success: false, tool: "chat", error: validated.error });
  }
  const prompt = validated.value;
  activity("ai.chat", { phase: "start", promptPreview: preview(prompt) });

  const result = await generateChatResponse(prompt);
  if (!result.ok) {
    const status = aiErrorStatus(result.errorType);
    activity("ai.error", { tool: "chat", errorType: result.errorType, status, details: result.error }, "error");
    return res.status(status).json({
      success: false,
      tool: "chat",
      error: "AI response unavailable",
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
    usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens },
    timestamp: new Date().toISOString(),
  });
});

app.post("/api/image", async (req: Request, res: Response) => {
  const body = req.body || {};
  const validated = validateTextField(body.prompt, "prompt");
  if (!validated.ok) {
    activity("request.reject", { tool: "image", reason: validated.error }, "warn");
    return res.status(400).json({ success: false, tool: "image", error: validated.error });
  }
  const rawPrompt = validated.value;
  activity("ai.image", { phase: "start", promptPreview: preview(rawPrompt) });

  const result = await enhanceImagePrompt(rawPrompt);
  if (!result.ok) {
    const status = aiErrorStatus(result.errorType);
    activity("ai.error", { tool: "image", errorType: result.errorType, status, details: result.error }, "error");
    return res.status(status).json({
      success: false,
      tool: "image",
      error: "Image prompt enhancement unavailable",
      errorType: result.errorType,
      hint: aiErrorHint(result.errorType),
      details: result.error,
      timestamp: new Date().toISOString(),
    });
  }

  activity("ai.image", { phase: "ok", chars: result.text.length });
  return res.json({
    success: true,
    tool: "image",
    rawPrompt,
    enhancedPrompt: result.text,
    imageUrl: `https://placehold.co/512x512/0f172a/f59e0b?text=${encodeURIComponent(rawPrompt)}`,
    model: result.model,
    truncated: result.truncated,
    usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens },
    timestamp: new Date().toISOString(),
  });
});

app.post("/api/code", async (req: Request, res: Response) => {
  const body = req.body || {};
  const validated = validateTextField(body.code, "code");
  if (!validated.ok) {
    activity("request.reject", { tool: "code", reason: validated.error }, "warn");
    return res.status(400).json({ success: false, tool: "code", error: validated.error });
  }
  const codeSnippet = validated.value;
  activity("ai.code", { phase: "start", chars: codeSnippet.length });

  const result = await auditCodeSnippet(codeSnippet);
  if (!result.ok) {
    const status = aiErrorStatus(result.errorType);
    activity("ai.error", { tool: "code", errorType: result.errorType, status, details: result.error }, "error");
    return res.status(status).json({
      success: false,
      tool: "code",
      error: "Code audit unavailable — no verdict was produced",
      errorType: result.errorType,
      hint: aiErrorHint(result.errorType),
      details: result.error,
      timestamp: new Date().toISOString(),
    });
  }

  activity("ai.code", { phase: "ok", score: result.audit.score, vulnerabilities: result.audit.vulnerabilities });
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
  const agentAddress = typeof body.agentAddress === "string" ? body.agentAddress : undefined;
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
