/** Persist only bounded diagnostics, never stacks or arbitrary error properties. */
export const OPERATION_ERROR_MAX_LENGTH = 4096;
const MAX_DEPTH = 4;
const MAX_NODES = 16;

export function redactOperationError(message: string): string {
  return message
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b(sk-[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, "[redacted]")
    .replace(/((?:["']?\b(?:api[_-]?key|(?:access|refresh|session)[_-]?token|client[_-]?secret|token|authorization|password|secret|cookie)["']?)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi, "$1[redacted]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

/** Leaf helper shared by operation owners. Cycles and aggregates stay bounded. */
export function operationErrorMessage(error: unknown): string {
  const seen = new Set<object>();
  let nodes = 0;
  const visit = (value: unknown, depth: number): string => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) return "[causes truncated]";
    if (!(value instanceof Error)) return redactOperationError(String(value)).slice(0, OPERATION_ERROR_MAX_LENGTH);
    if (seen.has(value)) return "[circular cause]";
    seen.add(value);
    let result = redactOperationError(value.message).slice(0, OPERATION_ERROR_MAX_LENGTH);
    if (value.cause !== undefined) result += `\nCause: ${visit(value.cause, depth + 1)}`;
    if (value instanceof AggregateError) {
      for (const child of value.errors.slice(0, MAX_NODES)) {
        if (nodes >= MAX_NODES) { result += "\n[causes truncated]"; break; }
        result += `\nCause: ${visit(child, depth + 1)}`;
      }
      if (value.errors.length > MAX_NODES) result += "\n[causes truncated]";
    }
    return result;
  };
  const text = visit(error, 0);
  return text.length <= OPERATION_ERROR_MAX_LENGTH ? text : `${text.slice(0, OPERATION_ERROR_MAX_LENGTH - 20)}\n[causes truncated]`;
}
