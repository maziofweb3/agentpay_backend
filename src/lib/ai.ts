import { Anthropic } from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";

const AGENT_ROUTER_BASE_URL = "https://agentrouter.org";
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_RETRIES = 1;

export type AIErrorType =
  | "no_key"
  | "auth"
  | "invalid_model"
  | "timeout"
  | "network"
  | "empty_response"
  | "unknown";

export type AIResult =
  | { ok: true; text: string; model: string; inputTokens: number; outputTokens: number; truncated: boolean }
  | { ok: false; errorType: AIErrorType; error: string };

export type AIProvider = "gemini" | "claude";

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

function isPlaceholderKey(key: string): boolean {
  return key.trim() === "" || key.includes("your_anthropic_claude_api_key_here") || key.includes("your_gemini_api_key_here");
}

function resolveBaseURL(apiKey: string): string | undefined {
  if (process.env.ANTHROPIC_BASE_URL) return process.env.ANTHROPIC_BASE_URL;
  return apiKey.startsWith("sk-ant-") ? undefined : AGENT_ROUTER_BASE_URL;
}

let cachedClient: Anthropic | null = null;
let cachedClientKey: string | null = null;

function getAnthropicClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || isPlaceholderKey(apiKey)) {
    throw new Error("FATAL: ANTHROPIC_API_KEY environment variable is missing or placeholder");
  }

  const baseURL = resolveBaseURL(apiKey);
  const cacheKey = `${apiKey}|${baseURL ?? "default"}`;
  if (cachedClient && cachedClientKey === cacheKey) return cachedClient;

  cachedClient = new Anthropic({
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
  cachedClientKey = cacheKey;
  return cachedClient;
}

let cachedGeminiClient: GoogleGenAI | null = null;
let cachedGeminiKey: string | null = null;

function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || isPlaceholderKey(apiKey)) {
    throw new Error("FATAL: GEMINI_API_KEY environment variable is missing or placeholder");
  }

  if (cachedGeminiClient && cachedGeminiKey === apiKey) return cachedGeminiClient;

  cachedGeminiClient = new GoogleGenAI({ apiKey });
  cachedGeminiKey = apiKey;
  return cachedGeminiClient;
}

export function classifyError(err: any): AIErrorType {
  const status = err?.status ?? err?.response?.status;
  const message = String(err?.message ?? err ?? "");

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
    if (resObj.trim().toLowerCase().startsWith("<!doctype") || resObj.toLowerCase().includes("aliyun_waf") || resObj.trim().toLowerCase().startsWith("<html")) {
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

async function runAnthropicCompletion(
  label: string,
  params: { maxTokens: number; system?: string; userContent: string }
): Promise<AIResult> {
  const client = getAnthropicClient();
  const model = getActiveModel();

  if (!client) {
    const error = "ANTHROPIC_API_KEY is not set — refusing to fabricate a response";
    console.error(`[AI] ✗ ${label} unavailable: ${error}`);
    return { ok: false, errorType: "no_key", error };
  }

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
      `[AI] ✓ ${label} (Claude) completed in ${durationMs}ms with ${model} (${inputTokens} in / ${outputTokens} out tokens)`
    );
    return { ok: true, text, model, inputTokens, outputTokens, truncated };
  } catch (err: any) {
    const durationMs = Date.now() - start;
    const errorType: AIErrorType = err instanceof AIGatewayError ? err.errorType : classifyError(err);
    const error = err?.message || String(err);

    console.error(`[AI] ✗ ${label} (Claude) failed in ${durationMs}ms [${errorType}] with ${model}: ${error}`);
    return { ok: false, errorType, error };
  }
}

async function runGeminiCompletion(
  label: string,
  params: { maxTokens: number; system?: string; userContent: string }
): Promise<AIResult> {
  const client = getGeminiClient();
  const model = getActiveGeminiModel();

  if (!client) {
    const error = "GEMINI_API_KEY is not set — refusing to fabricate a response";
    console.error(`[AI] ✗ ${label} unavailable: ${error}`);
    return { ok: false, errorType: "no_key", error };
  }

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
      `[AI] ✓ ${label} (Gemini) completed in ${durationMs}ms with ${model} (${inputTokens} in / ${outputTokens} out tokens)`
    );
    return { ok: true, text, model, inputTokens, outputTokens, truncated: false };
  } catch (err: any) {
    const durationMs = Date.now() - start;
    const errorType: AIErrorType = err instanceof AIGatewayError ? err.errorType : classifyError(err);
    const error = err?.message || String(err);

    console.error(`[AI] ✗ ${label} (Gemini) failed in ${durationMs}ms [${errorType}] with ${model}: ${error}`);
    return { ok: false, errorType, error };
  }
}

export async function generateChatResponse(prompt: string, provider: AIProvider = "gemini"): Promise<AIResult> {
  const params = {
    maxTokens: 1024,
    system: "You are AgentPay AI, a fast, helpful AI assistant built on BotChain. Provide concise, helpful answers.",
    userContent: prompt,
  };

  if (provider === "claude") {
    return runAnthropicCompletion("chat", params);
  }

  // Default: Gemini 2.5 Flash
  return runGeminiCompletion("chat", params);
}

export async function enhanceImagePrompt(prompt: string, provider: AIProvider = "gemini"): Promise<AIResult> {
  const params = {
    maxTokens: 256,
    userContent: `Enhance this image prompt into a detailed visual description for image generation:\n<prompt>\n${prompt}\n</prompt>`,
  };

  if (provider === "claude") {
    return runAnthropicCompletion("image prompt enhancement", params);
  }

  return runGeminiCompletion("image prompt enhancement", params);
}

export interface CodeAudit {
  score: string;
  vulnerabilities: number;
  summary: string;
  suggestions: string[];
}

export type CodeAuditResult = { ok: true; audit: CodeAudit; model: string } | { ok: false; errorType: AIErrorType; error: string };

const AUDIT_INSTRUCTIONS = `Audit the smart contract code below for security vulnerabilities and gas optimization.

Respond with ONLY a JSON object, no prose or markdown fences, in exactly this shape:
{"score":"A-F letter grade","vulnerabilities":<integer count>,"summary":"one sentence","suggestions":["...","..."]}`;

export async function auditCodeSnippet(code: string, provider: AIProvider = "gemini"): Promise<CodeAuditResult> {
  const params = {
    maxTokens: 1024,
    userContent: `${AUDIT_INSTRUCTIONS}\n\n<code>\n${code}\n</code>`,
  };

  const result = provider === "claude"
    ? await runAnthropicCompletion("code audit", params)
    : await runGeminiCompletion("code audit", params);

  if (!result.ok) return result;

  const audit = parseAuditJson(result.text);
  if (!audit) {
    console.error(`[AI] ✗ code audit returned unparseable output; refusing to synthesize a score`);
    return {
      ok: false,
      errorType: "empty_response",
      error: "Model did not return a parseable audit verdict",
    };
  }

  return { ok: true, audit, model: result.model };
}

export function parseAuditJson(text: string): CodeAudit | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
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
  cachedClient = null;
  cachedClientKey = null;
  cachedGeminiClient = null;
  cachedGeminiKey = null;
}
