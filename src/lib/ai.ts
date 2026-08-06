import { Anthropic } from "@anthropic-ai/sdk";

const DEFAULT_MODEL = "claude-opus-5";
const AGENT_ROUTER_BASE_URL = "https://agentrouter.org";

/** Request timeout. The SDK default is 10 minutes, which would hold a paid HTTP request open far too long. */
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

/** Resolved model id, exported so routes and /health report what is actually in use. */
export function getActiveModel(): string {
  return process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
}

function isPlaceholderKey(key: string): boolean {
  return key.trim() === "" || key.includes("your_anthropic_claude_api_key_here");
}

/**
 * Resolve the base URL for the configured key.
 *
 * An explicit ANTHROPIC_BASE_URL always wins. Otherwise `sk-ant-` keys are direct Anthropic
 * Console keys (SDK default), and anything else is assumed to be an AgentRouter gateway token.
 */
function resolveBaseURL(apiKey: string): string | undefined {
  if (process.env.ANTHROPIC_BASE_URL) return process.env.ANTHROPIC_BASE_URL;
  return apiKey.startsWith("sk-ant-") ? undefined : AGENT_ROUTER_BASE_URL;
}

let cachedClient: Anthropic | null = null;
let cachedClientKey: string | null = null;

/**
 * Lazily construct the client on first use so dotenv has already run, then memoize it so
 * connections are reused. The cache is keyed on the credentials it was built from.
 */
function getAnthropicClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || isPlaceholderKey(apiKey)) return null;

  const baseURL = resolveBaseURL(apiKey);
  const cacheKey = `${apiKey}|${baseURL ?? "default"}`;
  if (cachedClient && cachedClientKey === cacheKey) return cachedClient;

  cachedClient = new Anthropic({
    apiKey,
    baseURL,
    // AgentRouter gates on client identity; the header is sent when routing through a gateway.
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

/** Classify a thrown error so configuration problems are distinguishable from transient ones. */
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

/**
 * Normalize a completion into text + usage.
 *
 * Handles both real SDK objects and the raw JSON strings AgentRouter returns. Throws
 * AIGatewayError on gateway error bodies and on responses carrying no text, rather than
 * substituting placeholder prose that a caller would mistake for a real answer.
 *
 * Exported for unit testing.
 */
export function normalizeAnthropicResponse(rawResponse: unknown): NormalizedResponse {
  let resObj: any = rawResponse;

  // AgentRouter sometimes returns the payload as a JSON string (occasionally double-encoded).
  for (let i = 0; i < 2 && typeof resObj === "string"; i++) {
    try {
      resObj = JSON.parse(resObj);
    } catch {
      // Not JSON — a bare string body is the model's text.
      return { text: resObj as string, inputTokens: 0, outputTokens: 0, truncated: false };
    }
  }

  if (resObj === null || typeof resObj !== "object") {
    throw new AIGatewayError(
      `Gateway returned an unexpected ${resObj === null ? "null" : typeof resObj} payload`,
      "empty_response"
    );
  }

  // A gateway error body parses cleanly and has no content — surface it instead of returning "".
  if (resObj.error) {
    const message =
      typeof resObj.error === "string" ? resObj.error : resObj.error?.message || JSON.stringify(resObj.error);
    throw new AIGatewayError(message, classifyError({ status: resObj.error?.status, message }));
  }

  let text = "";
  if (Array.isArray(resObj.content)) {
    // Join every text block; taking only the first truncates multi-block responses.
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

/** Shared execution path: client lookup, call, normalize, log, classify failures. */
async function runCompletion(
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
      `[AI] ✓ ${label} completed in ${durationMs}ms with ${model} (${inputTokens} in / ${outputTokens} out tokens)`
    );
    if (truncated) {
      console.warn(`[AI] ⚠️  ${label} hit max_tokens (${params.maxTokens}) — output truncated`);
    }

    return { ok: true, text, model, inputTokens, outputTokens, truncated };
  } catch (err: any) {
    const durationMs = Date.now() - start;
    const errorType: AIErrorType = err instanceof AIGatewayError ? err.errorType : classifyError(err);
    const error = err?.message || String(err);

    console.error(`[AI] ✗ ${label} failed in ${durationMs}ms [${errorType}] with ${model}: ${error}`);
    if (errorType === "auth") {
      console.error(
        `[AI]    → The gateway accepted the key but refused the model. Check token model permissions and quota.`
      );
    } else if (errorType === "invalid_model") {
      console.error(`[AI]    → Model "${model}" was rejected. Set ANTHROPIC_MODEL to a model your token can access.`);
    }

    return { ok: false, errorType, error };
  }
}

export async function generateChatResponse(prompt: string): Promise<AIResult> {
  return runCompletion("chat", {
    maxTokens: 1024,
    system: "You are AgentPay AI, a fast, helpful AI assistant built on BotChain. Provide concise, helpful answers.",
    userContent: prompt,
  });
}

export async function enhanceImagePrompt(prompt: string): Promise<AIResult> {
  return runCompletion("image prompt enhancement", {
    maxTokens: 256,
    userContent: `Enhance this image prompt into a detailed visual description for image generation:\n<prompt>\n${prompt}\n</prompt>`,
  });
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

/**
 * Audit a snippet. The model's verdict is parsed from its JSON output — a score is never
 * invented locally, and a failed call yields an error rather than a passing grade.
 */
export async function auditCodeSnippet(code: string): Promise<CodeAuditResult> {
  const result = await runCompletion("code audit", {
    maxTokens: 1024,
    // Delimited so a snippet containing quotes cannot escape the surrounding framing.
    userContent: `${AUDIT_INSTRUCTIONS}\n\n<code>\n${code}\n</code>`,
  });

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

/** Extract the audit verdict from the model's reply. Returns null when it cannot be trusted. */
export function parseAuditJson(text: string): CodeAudit | null {
  // Tolerate ```json fences and surrounding prose by locating the outermost object.
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

/** Test seam: drop the memoized client so a test can change env between cases. */
export function __resetClientCache(): void {
  cachedClient = null;
  cachedClientKey = null;
}
