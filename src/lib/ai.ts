import { Anthropic } from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import { cleanErrorMessage } from "./validation.js";

const AGENT_ROUTER_BASE_URL = "https://agentrouter.org";
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_RETRIES = 1;

export type AIErrorType =
  | "no_key"
  | "auth"
  | "invalid_model"
  | "rate_limit"
  | "timeout"
  | "network"
  | "empty_response"
  | "unknown";

export interface QuotaStatus {
  exceeded: boolean;
  retryInSec: number;
  message?: string;
}

export type AIProvider = "gemini" | "claude";

export type AIResult =
  | { ok: true; text: string; model: string; inputTokens: number; outputTokens: number; truncated: boolean }
  | { ok: false; errorType: AIErrorType; error: string };

/* -------------------------------------------------------------------------- */
/* Multi-Key Pool & Cooldown Tracking                                        */
/* -------------------------------------------------------------------------- */

const keyCooldownMap = new Map<string, { until: number; message: string }>();
const anthropicClientMap = new Map<string, Anthropic>();
const geminiClientMap = new Map<string, GoogleGenAI>();

function isPlaceholderKey(key: string): boolean {
  return (
    key.trim() === "" ||
    key.includes("your_anthropic_claude_api_key_here") ||
    key.includes("your_gemini_api_key_here")
  );
}

function parseKeysFromEnv(primaryVar: string, fallbackVar?: string): string[] {
  const raw = process.env[primaryVar] || (fallbackVar ? process.env[fallbackVar] : "") || "";
  if (!raw.trim()) return [];
  return raw
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0 && !isPlaceholderKey(k));
}

export function getProviderKeys(provider: AIProvider): string[] {
  if (provider === "gemini") {
    return parseKeysFromEnv("GEMINI_API_KEY", "GEMINI_API_KEYS");
  }
  return parseKeysFromEnv("ANTHROPIC_API_KEY", "ANTHROPIC_API_KEYS");
}

export function markKeyExceeded(key: string, retryDelaySec = 60, customMsg?: string): void {
  const delaySec = Math.max(retryDelaySec, 15);
  const until = Date.now() + delaySec * 1000;
  keyCooldownMap.set(key, {
    until,
    message: customMsg || `API key on cooldown for ${delaySec}s`,
  });
}

export function isKeyAvailable(key: string): boolean {
  const state = keyCooldownMap.get(key);
  if (!state) return true;
  if (Date.now() >= state.until) {
    keyCooldownMap.delete(key);
    return true;
  }
  return false;
}

export function getAvailableKeysForProvider(provider: AIProvider): string[] {
  const allKeys = getProviderKeys(provider);
  const available = allKeys.filter(isKeyAvailable);
  return available.length > 0 ? available : allKeys;
}

export function markQuotaExceeded(provider: AIProvider, retryDelaySec = 60, customMsg?: string): void {
  const keys = getAvailableKeysForProvider(provider);
  for (const key of keys) {
    markKeyExceeded(key, retryDelaySec, customMsg);
  }
}

export function checkQuotaStatus(provider: AIProvider): QuotaStatus {
  const allKeys = getProviderKeys(provider);
  if (allKeys.length === 0) {
    return {
      exceeded: true,
      retryInSec: 60,
      message: `No ${provider} API keys configured in environment`,
    };
  }

  const available = allKeys.filter(isKeyAvailable);
  if (available.length > 0) {
    return { exceeded: false, retryInSec: 0 };
  }

  // All keys are currently on cooldown! Find the key that will recover earliest
  let earliestUntil = Infinity;
  let customMsg = `All ${provider} API keys are currently exhausted.`;

  for (const key of allKeys) {
    const state = keyCooldownMap.get(key);
    if (state && state.until < earliestUntil) {
      earliestUntil = state.until;
      if (state.message) customMsg = state.message;
    }
  }

  if (!Number.isFinite(earliestUntil) || Date.now() >= earliestUntil) {
    return { exceeded: false, retryInSec: 0 };
  }

  const retryInSec = Math.ceil((earliestUntil - Date.now()) / 1000);
  return { exceeded: true, retryInSec, message: customMsg };
}

function maskKey(key: string): string {
  if (!key || key.length <= 8) return "****";
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

/* -------------------------------------------------------------------------- */
/* Client Constructors                                                        */
/* -------------------------------------------------------------------------- */

/** Resolved Claude model id from environment. */
export function getActiveModel(): string {
  const model = process.env.ANTHROPIC_MODEL;
  if (!model) throw new Error("FATAL: ANTHROPIC_MODEL environment variable is missing");
  return model;
}

/** Resolved Gemini model id from environment. */
export function getActiveGeminiModel(): string {
  const model = process.env.GEMINI_MODEL;
  if (!model) throw new Error("FATAL: GEMINI_MODEL environment variable is missing");
  return model;
}

function resolveBaseURL(apiKey: string): string | undefined {
  if (process.env.ANTHROPIC_BASE_URL) return process.env.ANTHROPIC_BASE_URL;
  return apiKey.startsWith("sk-ant-") ? undefined : AGENT_ROUTER_BASE_URL;
}

function getAnthropicClientForKey(apiKey: string): Anthropic {
  const baseURL = resolveBaseURL(apiKey);
  const cacheKey = `${apiKey}|${baseURL ?? "default"}`;
  let client = anthropicClientMap.get(cacheKey);
  if (!client) {
    client = new Anthropic({
      apiKey,
      baseURL,
      defaultHeaders: baseURL
        ? {
            "User-Agent": process.env.ANTHROPIC_USER_AGENT || "Cline/3.0.0",
            Accept: "application/json",
          }
        : undefined,
      timeout: REQUEST_TIMEOUT_MS,
      maxRetries: MAX_RETRIES,
    });
    anthropicClientMap.set(cacheKey, client);
  }
  return client;
}

function getGeminiClientForKey(apiKey: string): GoogleGenAI {
  let client = geminiClientMap.get(apiKey);
  if (!client) {
    client = new GoogleGenAI({ apiKey });
    geminiClientMap.set(apiKey, client);
  }
  return client;
}

/* -------------------------------------------------------------------------- */
/* Error Classification & Normalization                                      */
/* -------------------------------------------------------------------------- */

export function classifyError(err: any): AIErrorType {
  const status = err?.status ?? err?.response?.status ?? err?.error?.code ?? err?.code;
  const message = String(err?.message ?? err?.error?.message ?? err ?? "");
  const statusStr = String(err?.error?.status ?? err?.status ?? "");

  if (
    status === 429 ||
    statusStr === "RESOURCE_EXHAUSTED" ||
    /quota|RESOURCE_EXHAUSTED|rate_limit|rate limit|too many requests|429/i.test(message)
  ) {
    return "rate_limit";
  }

  if (status === 401 || status === 403) return "auth";
  if (status === 404 || (/model/i.test(message) && /not found|unknown|无权访问/i.test(message))) return "invalid_model";
  if (err?.name === "APIConnectionTimeoutError" || /timeout|ETIMEDOUT|ECONNABORTED/i.test(message)) return "timeout";
  if (typeof status === "number" && status >= 500) return "network";
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed/i.test(message)) return "network";
  return "unknown";
}

export class AIGatewayError extends Error {
  constructor(message: string, readonly errorType: AIErrorType) {
    super(message);
    this.name = "AIGatewayError";
  }
}

export interface NormalizedResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  truncated: boolean;
}

export function normalizeAnthropicResponse(rawResponse: unknown): NormalizedResponse {
  let resObj: any = rawResponse;

  for (let i = 0; i < 2 && typeof resObj === "string"; i++) {
    if (
      resObj.trim().toLowerCase().startsWith("<!doctype") ||
      resObj.toLowerCase().includes("aliyun_waf") ||
      resObj.trim().toLowerCase().startsWith("<html")
    ) {
      throw new AIGatewayError(
        "AI gateway returned an HTML firewall verification page (WAF challenge)",
        "network"
      );
    }
    try {
      resObj = JSON.parse(resObj);
    } catch {
      return { text: resObj as string, inputTokens: 0, outputTokens: 0, truncated: false };
    }
  }

  if (resObj === null || typeof resObj !== "object") {
    throw new AIGatewayError(
      `Gateway returned an unexpected ${resObj === null ? "null" : typeof resObj} payload`,
      "empty_response"
    );
  }

  if (resObj.error) {
    const message =
      typeof resObj.error === "string" ? resObj.error : resObj.error?.message || JSON.stringify(resObj.error);
    throw new AIGatewayError(message, classifyError({ status: resObj.error?.status, message }));
  }

  let text = "";
  if (Array.isArray(resObj.content)) {
    text = resObj.content
      .filter((b: any) => b?.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("\n");
  } else if (typeof resObj.content === "string") {
    text = resObj.content;
  }

  if (text.trim() === "") {
    throw new AIGatewayError("Gateway returned a response with no text content", "empty_response");
  }

  const usage = resObj.usage ?? {};
  const inputTokens =
    (usage.input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0) +
    (usage.cache_read_input_tokens || 0);

  return {
    text,
    inputTokens,
    outputTokens: usage.output_tokens || 0,
    truncated: resObj.stop_reason === "max_tokens",
  };
}

/* -------------------------------------------------------------------------- */
/* Failover Execution Runners                                                 */
/* -------------------------------------------------------------------------- */

async function runAnthropicCompletion(
  label: string,
  params: { maxTokens: number; system?: string; userContent: string }
): Promise<AIResult> {
  const allKeys = getProviderKeys("claude");
  if (allKeys.length === 0) {
    const error = "ANTHROPIC_API_KEY is not set — refusing to fabricate a response";
    console.error(`[AI] ✗ ${label} unavailable: ${error}`);
    return { ok: false, errorType: "no_key", error };
  }

  const keys = getAvailableKeysForProvider("claude");
  const model = getActiveModel();
  let lastErrorResult: AIResult | null = null;

  for (let i = 0; i < keys.length; i++) {
    const apiKey = keys[i];
    const keyMasked = maskKey(apiKey);
    const client = getAnthropicClientForKey(apiKey);
    const start = Date.now();

    try {
      const rawResponse = await client.messages.create({
        model,
        max_tokens: params.maxTokens,
        ...(params.system ? { system: params.system } : {}),
        messages: [{ role: "user", content: params.userContent }],
      });

      const { text, inputTokens, outputTokens, truncated } = normalizeAnthropicResponse(rawResponse);
      const durationMs = Date.now() - start;

      console.log(
        `[AI] ✓ ${label} (Claude) [Key ${i + 1}/${keys.length} ${keyMasked}] completed in ${durationMs}ms with ${model} (${inputTokens} in / ${outputTokens} out tokens)`
      );
      return { ok: true, text, model, inputTokens, outputTokens, truncated };
    } catch (err: any) {
      const durationMs = Date.now() - start;
      const errorType: AIErrorType = err instanceof AIGatewayError ? err.errorType : classifyError(err);
      const error = cleanErrorMessage(err?.message || String(err));

      if (errorType === "rate_limit" || errorType === "auth") {
        markKeyExceeded(apiKey, 60, error);
        console.warn(
          `[AI] ⚠️ ${label} (Claude) [Key ${i + 1}/${keys.length} ${keyMasked}] failed [${errorType}]: ${error}.${
            i + 1 < keys.length ? ` Switching to key #${i + 2}...` : " All keys exhausted."
          }`
        );
      } else {
        console.error(
          `[AI] ✗ ${label} (Claude) [Key ${i + 1}/${keys.length} ${keyMasked}] failed in ${durationMs}ms [${errorType}]: ${error}`
        );
      }
      lastErrorResult = { ok: false, errorType, error };
    }
  }

  return lastErrorResult || { ok: false, errorType: "unknown", error: "Claude completion failed across all keys" };
}

async function runGeminiCompletion(
  label: string,
  params: { maxTokens: number; system?: string; userContent: string }
): Promise<AIResult> {
  const allKeys = getProviderKeys("gemini");
  if (allKeys.length === 0) {
    const error = "GEMINI_API_KEY is not set — refusing to fabricate a response";
    console.error(`[AI] ✗ ${label} unavailable: ${error}`);
    return { ok: false, errorType: "no_key", error };
  }

  const keys = getAvailableKeysForProvider("gemini");
  const model = getActiveGeminiModel();
  let lastErrorResult: AIResult | null = null;

  for (let i = 0; i < keys.length; i++) {
    const apiKey = keys[i];
    const keyMasked = maskKey(apiKey);
    const client = getGeminiClientForKey(apiKey);
    const start = Date.now();

    try {
      const response = await client.models.generateContent({
        model,
        contents: params.userContent,
        config: {
          ...(params.system ? { systemInstruction: params.system } : {}),
          maxOutputTokens: params.maxTokens,
        },
      });

      const text = response.text || "";
      const durationMs = Date.now() - start;

      if (!text.trim()) {
        throw new AIGatewayError("Gemini API returned an empty response text", "empty_response");
      }

      const inputTokens = response.usageMetadata?.promptTokenCount || 0;
      const outputTokens = response.usageMetadata?.candidatesTokenCount || 0;

      console.log(
        `[AI] ✓ ${label} (Gemini) [Key ${i + 1}/${keys.length} ${keyMasked}] completed in ${durationMs}ms with ${model} (${inputTokens} in / ${outputTokens} out tokens)`
      );
      return { ok: true, text, model, inputTokens, outputTokens, truncated: false };
    } catch (err: any) {
      const durationMs = Date.now() - start;
      const errorType: AIErrorType = err instanceof AIGatewayError ? err.errorType : classifyError(err);
      const error = cleanErrorMessage(err?.message || String(err));

      if (errorType === "rate_limit" || errorType === "auth") {
        const retryMatch = String(err?.message || "").match(/Please retry in (\d+(?:\.\d+)?s?)/i);
        const retrySec = retryMatch ? Math.round(parseFloat(retryMatch[1])) : 60;
        markKeyExceeded(apiKey, retrySec, error);

        console.warn(
          `[AI] ⚠️ ${label} (Gemini) [Key ${i + 1}/${keys.length} ${keyMasked}] failed [${errorType}]: ${error}.${
            i + 1 < keys.length ? ` Switching to key #${i + 2}...` : " All keys exhausted."
          }`
        );
      } else {
        console.error(
          `[AI] ✗ ${label} (Gemini) [Key ${i + 1}/${keys.length} ${keyMasked}] failed in ${durationMs}ms [${errorType}]: ${error}`
        );
      }
      lastErrorResult = { ok: false, errorType, error };
    }
  }

  return lastErrorResult || { ok: false, errorType: "unknown", error: "Gemini completion failed across all keys" };
}

async function runGeminiJsonCompletion(
  label: string,
  params: { maxTokens: number; system?: string; userContent: string }
): Promise<AIResult> {
  const allKeys = getProviderKeys("gemini");
  if (allKeys.length === 0) {
    const error = "GEMINI_API_KEY is not set — refusing to fabricate a response";
    console.error(`[AI] ✗ ${label} unavailable: ${error}`);
    return { ok: false, errorType: "no_key", error };
  }

  const keys = getAvailableKeysForProvider("gemini");
  const model = getActiveGeminiModel();
  let lastErrorResult: AIResult | null = null;

  for (let i = 0; i < keys.length; i++) {
    const apiKey = keys[i];
    const keyMasked = maskKey(apiKey);
    const client = getGeminiClientForKey(apiKey);
    const start = Date.now();

    try {
      const response = await client.models.generateContent({
        model,
        contents: params.userContent,
        config: {
          ...(params.system ? { systemInstruction: params.system } : {}),
          maxOutputTokens: params.maxTokens,
          responseMimeType: "application/json",
        },
      });

      const text = response.text || "";
      const durationMs = Date.now() - start;

      if (!text.trim()) {
        throw new AIGatewayError("Gemini JSON API returned an empty response text", "empty_response");
      }

      const inputTokens = response.usageMetadata?.promptTokenCount || 0;
      const outputTokens = response.usageMetadata?.candidatesTokenCount || 0;

      console.log(
        `[AI] ✓ ${label} (Gemini/JSON) [Key ${i + 1}/${keys.length} ${keyMasked}] completed in ${durationMs}ms with ${model} (${inputTokens} in / ${outputTokens} out tokens)`
      );
      return { ok: true, text, model, inputTokens, outputTokens, truncated: false };
    } catch (err: any) {
      const durationMs = Date.now() - start;
      const errorType: AIErrorType = err instanceof AIGatewayError ? err.errorType : classifyError(err);
      const error = cleanErrorMessage(err?.message || String(err));

      if (errorType === "rate_limit" || errorType === "auth") {
        const retryMatch = String(err?.message || "").match(/Please retry in (\d+(?:\.\d+)?s?)/i);
        const retrySec = retryMatch ? Math.round(parseFloat(retryMatch[1])) : 60;
        markKeyExceeded(apiKey, retrySec, error);

        console.warn(
          `[AI] ⚠️ ${label} (Gemini/JSON) [Key ${i + 1}/${keys.length} ${keyMasked}] failed [${errorType}]: ${error}.${
            i + 1 < keys.length ? ` Switching to key #${i + 2}...` : " All keys exhausted."
          }`
        );
      } else {
        console.error(
          `[AI] ✗ ${label} (Gemini/JSON) [Key ${i + 1}/${keys.length} ${keyMasked}] failed in ${durationMs}ms [${errorType}]: ${error}`
        );
      }
      lastErrorResult = { ok: false, errorType, error };
    }
  }

  return lastErrorResult || { ok: false, errorType: "unknown", error: "Gemini JSON completion failed across all keys" };
}

/* -------------------------------------------------------------------------- */
/* Public API Functions                                                       */
/* -------------------------------------------------------------------------- */

export async function generateChatResponse(
  prompt: string,
  provider: AIProvider = "gemini",
  maxTokens?: number
): Promise<AIResult> {
  const budget = maxTokens ?? 256;
  const params = {
    maxTokens: budget,
    system: `You are AgentPay AI, a fast, helpful AI assistant built on BotChain.
Provide complete, clear, and direct answers without unnecessary filler. Always complete your sentences fully.`,
    userContent: prompt,
  };

  if (provider === "claude") {
    return runAnthropicCompletion("chat", params);
  }

  return runGeminiCompletion("chat", params);
}

export async function enhanceImagePrompt(
  prompt: string,
  provider: AIProvider = "gemini",
  imageBase64?: string,
  maxTokens?: number
): Promise<AIResult> {
  if (imageBase64) {
    const budget = maxTokens ?? 250;
    const allKeys = getProviderKeys("gemini");
    if (allKeys.length === 0) {
      return { ok: false, errorType: "no_key", error: "GEMINI_API_KEY is not set" };
    }

    const keys = getAvailableKeysForProvider("gemini");
    const model = getActiveGeminiModel();
    let lastErrorResult: AIResult | null = null;

    for (let i = 0; i < keys.length; i++) {
      const apiKey = keys[i];
      const keyMasked = maskKey(apiKey);
      const client = getGeminiClientForKey(apiKey);
      const start = Date.now();

      try {
        const matches = imageBase64.match(/^data:([^;]+);base64,(.+)$/);
        const mimeType = matches ? matches[1] : "image/jpeg";
        const base64Data = matches ? matches[2] : imageBase64;

        const response = await client.models.generateContent({
          model,
          contents: [
            {
              role: "user",
              parts: [
                { text: prompt ? `Analyze this image and respond to: ${prompt}` : "Describe this image in detail, including style, colors, composition, and notable elements." },
                { inlineData: { mimeType, data: base64Data } },
              ],
            },
          ],
          config: { maxOutputTokens: budget },
        });

        const text = response.text || "";
        if (!text.trim()) {
          throw new AIGatewayError("Gemini vision returned an empty response", "empty_response");
        }

        const durationMs = Date.now() - start;
        const inputTokens = response.usageMetadata?.promptTokenCount || 0;
        const outputTokens = response.usageMetadata?.candidatesTokenCount || 0;
        console.log(`[AI] ✓ image vision (Gemini) [Key ${i + 1}/${keys.length} ${keyMasked}] completed in ${durationMs}ms`);
        return { ok: true, text, model, inputTokens, outputTokens, truncated: false };
      } catch (err: any) {
        const durationMs = Date.now() - start;
        const errorType: AIErrorType = err instanceof AIGatewayError ? err.errorType : classifyError(err);
        const error = cleanErrorMessage(err?.message || String(err));
        if (errorType === "rate_limit" || errorType === "auth") {
          markKeyExceeded(apiKey, 60, error);
          console.warn(
            `[AI] ⚠️ image vision (${provider}) [Key ${i + 1}/${keys.length} ${keyMasked}] failed [${errorType}]: ${error}.${
              i + 1 < keys.length ? ` Switching to key #${i + 2}...` : " All keys exhausted."
            }`
          );
        } else {
          console.error(`[AI] ✗ image vision (${provider}) [Key ${i + 1}/${keys.length} ${keyMasked}] failed in ${durationMs}ms [${errorType}]: ${error}`);
        }
        lastErrorResult = { ok: false, errorType, error };
      }
    }

    return lastErrorResult || { ok: false, errorType: "unknown", error: "Gemini vision failed across all keys" };
  }

  const params = {
    maxTokens: 256,
    userContent: `Enhance this image prompt into a detailed, vivid visual description for AI image generation:\n<prompt>\n${prompt}\n</prompt>\nReturn only the enhanced description, no preamble.`,
  };

  if (provider === "claude") {
    return runAnthropicCompletion("image prompt enhancement", params);
  }

  return runGeminiCompletion("image prompt enhancement", params);
}

/** Generate an image using Google Imagen 3 and return a base64 data URI. */
export async function generateImageVisual(
  enhancedPrompt: string
): Promise<{ ok: true; imageDataUri: string } | { ok: false; errorType: AIErrorType; error: string }> {
  const allKeys = getProviderKeys("gemini");
  if (allKeys.length === 0) {
    return { ok: false, errorType: "no_key", error: "GEMINI_API_KEY is not set" };
  }

  const keys = getAvailableKeysForProvider("gemini");
  let lastError: { errorType: AIErrorType; error: string } | null = null;

  for (let i = 0; i < keys.length; i++) {
    const apiKey = keys[i];
    const keyMasked = maskKey(apiKey);
    const client = getGeminiClientForKey(apiKey);
    const start = Date.now();

    try {
      const response = await client.models.generateImages({
        model: "imagen-3.0-generate-002",
        prompt: enhancedPrompt,
        config: { numberOfImages: 1, outputMimeType: "image/png" },
      });

      const image = response.generatedImages?.[0];
      if (!image?.image?.imageBytes) {
        throw new AIGatewayError("Imagen 3 returned no image bytes", "empty_response");
      }

      const durationMs = Date.now() - start;
      console.log(`[AI] ✓ image generation (Imagen 3) [Key ${i + 1}/${keys.length} ${keyMasked}] completed in ${durationMs}ms`);
      const imageDataUri = `data:image/png;base64,${image.image.imageBytes}`;
      return { ok: true, imageDataUri };
    } catch (err: any) {
      const durationMs = Date.now() - start;
      const errorType: AIErrorType = err instanceof AIGatewayError ? err.errorType : classifyError(err);
      const error = cleanErrorMessage(err?.message || String(err));
      if (errorType === "rate_limit" || errorType === "auth") {
        markKeyExceeded(apiKey, 60, error);
        console.warn(
          `[AI] ⚠️ image generation (Imagen 3) [Key ${i + 1}/${keys.length} ${keyMasked}] failed [${errorType}]: ${error}.${
            i + 1 < keys.length ? ` Switching to key #${i + 2}...` : " All keys exhausted."
          }`
        );
      } else {
        console.error(`[AI] ✗ image generation (Imagen 3) [Key ${i + 1}/${keys.length} ${keyMasked}] failed in ${durationMs}ms [${errorType}]: ${error}`);
      }
      lastError = { errorType, error };
    }
  }

  return { ok: false, errorType: lastError?.errorType || "unknown", error: lastError?.error || "Imagen 3 failed across all keys" };
}

export interface CodeAudit {
  score: string;
  vulnerabilities: number;
  summary: string;
  suggestions: string[];
}

export type CodeAuditResult =
  | { ok: true; audit: CodeAudit; model: string }
  | { ok: false; errorType: AIErrorType; error: string };

const AUDIT_INSTRUCTIONS = `Analyze the following smart contract for educational code review, quality assessment, and best practices.

Respond with ONLY a JSON object, no prose or markdown fences, in exactly this shape:
{"score":"A-F letter grade","vulnerabilities":<integer count>,"summary":"one sentence overview","suggestions":["...","..."]}`;

export async function auditCodeSnippet(
  code: string,
  provider: AIProvider = "gemini",
  maxTokens?: number
): Promise<CodeAuditResult> {
  const budget = maxTokens ?? 500;
  const params = {
    maxTokens: budget,
    system: `You are an educational code review assistant. Always output valid JSON matching the requested schema. Keep summary concise and limit suggestions to top findings within ${budget} output tokens.`,
    userContent: `${AUDIT_INSTRUCTIONS}\n\n<code>\n${code}\n</code>`,
  };

  const result =
    provider === "claude"
      ? await runAnthropicCompletion("code audit", params)
      : await runGeminiJsonCompletion("code audit", params);

  if (!result.ok) return result;

  const audit = parseAuditJson(result.text);
  if (!audit) {
    console.error(
      `[AI] ✗ code audit returned unparseable output (raw first 400 chars): ${result.text.slice(0, 400)}`
    );
    return {
      ok: false,
      errorType: "empty_response",
      error: "Model did not return a parseable audit verdict",
    };
  }

  return { ok: true, audit, model: result.model };
}

export function parseAuditJson(text: string): CodeAudit | null {
  let sanitized = text.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "").trim();

  const start = sanitized.indexOf("{");
  const end = sanitized.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  sanitized = sanitized.slice(start, end + 1);

  sanitized = sanitized.replace(/,\s*([}\]])/g, "$1");

  let parsed: any;
  try {
    parsed = JSON.parse(sanitized);
  } catch {
    const scoreMatch = sanitized.match(/"score"\s*:\s*"([^"]+)"/);
    const vulnMatch = sanitized.match(/"vulnerabilities"\s*:\s*(\d+)/);
    const summaryMatch = sanitized.match(/"summary"\s*:\s*"([^"]+)"/);
    if (!scoreMatch || !vulnMatch) return null;
    return {
      score: scoreMatch[1],
      vulnerabilities: parseInt(vulnMatch[1], 10),
      summary: summaryMatch ? summaryMatch[1] : "",
      suggestions: [],
    };
  }

  const vulnerabilities = Number(parsed?.vulnerabilities);
  if (typeof parsed?.score !== "string" || !Number.isFinite(vulnerabilities)) return null;

  const suggestions = Array.isArray(parsed.suggestions)
    ? parsed.suggestions.filter((s: unknown): s is string => typeof s === "string")
    : [];

  return {
    score: parsed.score,
    vulnerabilities,
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    suggestions,
  };
}

export function __resetClientCache(): void {
  keyCooldownMap.clear();
  anthropicClientMap.clear();
  geminiClientMap.clear();
}
