import type { AIErrorType } from "./ai.js";

/** Upper bound on user-supplied text, applied before any AI call is made. */
export const MAX_INPUT_CHARS = 10_000;

export type ValidationResult = { ok: true; value: string } | { ok: false; error: string };

/**
 * Validate a user-supplied string field.
 *
 * Routes previously called `.slice()`/`.length` straight off the JSON body, so a non-string
 * value threw a TypeError and produced a 500 after payment had already settled.
 */
export function validateTextField(value: unknown, field: string): ValidationResult {
  if (value === undefined || value === null) {
    return { ok: false, error: `Missing required '${field}' field` };
  }
  if (typeof value !== "string") {
    return { ok: false, error: `'${field}' must be a string, received ${typeof value}` };
  }
  if (value.trim() === "") {
    return { ok: false, error: `'${field}' must not be empty` };
  }
  if (value.length > MAX_INPUT_CHARS) {
    return { ok: false, error: `'${field}' exceeds the ${MAX_INPUT_CHARS} character limit (received ${value.length})` };
  }
  return { ok: true, value };
}

/** Truncate for log lines without mutating what is sent to the model. */
export function preview(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/**
 * HTTP status for an AI failure. Configuration problems are the operator's fault (503,
 * the service is misconfigured and no retry will help); upstream failures are 502.
 */
export function aiErrorStatus(errorType: AIErrorType): 502 | 503 | 504 {
  switch (errorType) {
    case "no_key":
    case "auth":
    case "invalid_model":
      return 503;
    case "timeout":
      return 504;
    default:
      return 502;
  }
}

/** Operator-facing hint attached to error responses so failures are self-explaining. */
export function aiErrorHint(errorType: AIErrorType): string {
  switch (errorType) {
    case "no_key":
      return "ANTHROPIC_API_KEY is not configured on the server.";
    case "auth":
      return "The AI gateway rejected the credentials or denied access to the configured model.";
    case "invalid_model":
      return "The configured ANTHROPIC_MODEL is not available to this token.";
    case "timeout":
      return "The AI gateway did not respond in time.";
    case "network":
      return "The AI gateway is unreachable or returned a server error.";
    case "empty_response":
      return "The AI gateway returned a malformed or empty response.";
    default:
      return "The AI request failed for an unexpected reason.";
  }
}
