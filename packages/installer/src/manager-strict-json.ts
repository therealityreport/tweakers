/**
 * Strict JSON for the manager wire/storage boundary. JSON.parse intentionally
 * accepts duplicate keys by keeping the last value, which is not acceptable
 * for an approval or durable-operation document. This scanner validates the
 * complete RFC 8259 shape first, including every nested object, then hands the
 * value to JSON.parse for materialization.
 */
export class ManagerStrictJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagerStrictJsonError";
  }
}

export function parseManagerStrictJson(
  input: string | Uint8Array,
  options: { maxBytes?: number; label?: string } = {},
): unknown {
  const maxBytes = options.maxBytes ?? 64 * 1024;
  const label = options.label ?? "manager JSON";
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  if (bytes.byteLength > maxBytes) throw new ManagerStrictJsonError(`${label} exceeds ${maxBytes} bytes`);

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ManagerStrictJsonError(`${label} is not valid UTF-8`);
  }

  try {
    const scanner = new StrictJsonScanner(text, label);
    scanner.scanDocument();
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof ManagerStrictJsonError) throw error;
    throw new ManagerStrictJsonError(`${label} is invalid JSON: ${errorMessage(error)}`);
  }
}

export function parseManagerStrictJsonObject(
  input: string | Uint8Array,
  options: { maxBytes?: number; label?: string } = {},
): Record<string, unknown> {
  const value = parseManagerStrictJson(input, options);
  if (!isRecord(value)) throw new ManagerStrictJsonError(`${options.label ?? "manager JSON"} must be an object`);
  return value;
}

export function assertManagerExactObjectKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) {
    throw new ManagerStrictJsonError(`${label} has unknown or missing fields`);
  }
}

export function isManagerJsonObject(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}

class StrictJsonScanner {
  private index = 0;

  constructor(private readonly text: string, private readonly label: string) {}

  scanDocument(): void {
    this.skipWhitespace();
    this.scanValue();
    this.skipWhitespace();
    if (this.index !== this.text.length) this.fail("trailing data");
  }

  private scanValue(): void {
    this.skipWhitespace();
    const character = this.peek();
    if (character === undefined) this.fail("missing value");
    if (character === "{") {
      this.scanObject();
      return;
    }
    if (character === "[") {
      this.scanArray();
      return;
    }
    if (character === '"') {
      this.scanString();
      return;
    }
    if (character === "t") return this.scanLiteral("true");
    if (character === "f") return this.scanLiteral("false");
    if (character === "n") return this.scanLiteral("null");
    this.scanNumber();
  }

  private scanObject(): void {
    this.consume("{");
    this.skipWhitespace();
    if (this.consumeIf("}")) return;
    const keys = new Set<string>();
    while (true) {
      this.skipWhitespace();
      if (this.peek() !== '"') this.fail("object key is missing");
      const key = this.scanString();
      if (keys.has(key)) this.fail(`repeats key ${JSON.stringify(key)}`);
      keys.add(key);
      this.skipWhitespace();
      this.consume(":");
      this.scanValue();
      this.skipWhitespace();
      if (this.consumeIf("}")) return;
      this.consume(",");
    }
  }

  private scanArray(): void {
    this.consume("[");
    this.skipWhitespace();
    if (this.consumeIf("]")) return;
    while (true) {
      this.scanValue();
      this.skipWhitespace();
      if (this.consumeIf("]")) return;
      this.consume(",");
    }
  }

  private scanString(): string {
    const start = this.index;
    this.consume('"');
    while (true) {
      const code = this.text.charCodeAt(this.index);
      if (Number.isNaN(code)) this.fail("unterminated string");
      this.index += 1;
      if (code === 0x22) break;
      if (code < 0x20) this.fail("control character in string");
      if (code !== 0x5c) continue;
      const escape = this.text.charCodeAt(this.index);
      if (Number.isNaN(escape)) this.fail("unterminated escape");
      this.index += 1;
      if (escape === 0x75) {
        for (let offset = 0; offset < 4; offset += 1) {
          const hex = this.text.charCodeAt(this.index + offset);
          if (!isHexDigit(hex)) this.fail("invalid unicode escape");
        }
        this.index += 4;
      } else if (![0x22, 0x5c, 0x2f, 0x62, 0x66, 0x6e, 0x72, 0x74].includes(escape)) {
        this.fail("invalid string escape");
      }
    }
    const source = this.text.slice(start, this.index);
    try {
      return JSON.parse(source) as string;
    } catch {
      this.fail("invalid string");
    }
  }

  private scanLiteral(literal: string): void {
    if (this.text.slice(this.index, this.index + literal.length) !== literal) this.fail(`invalid literal ${literal}`);
    this.index += literal.length;
  }

  private scanNumber(): void {
    const start = this.index;
    if (this.consumeIf("-")) {
      if (this.peek() === undefined) this.fail("invalid number");
    }
    if (this.consumeIf("0")) {
      if (isDigit(this.text.charCodeAt(this.index))) this.fail("leading zero in number");
    } else {
      const first = this.text.charCodeAt(this.index);
      if (first < 0x31 || first > 0x39) this.fail("invalid number");
      this.index += 1;
      while (isDigit(this.text.charCodeAt(this.index))) this.index += 1;
    }
    if (this.consumeIf(".")) {
      if (!isDigit(this.text.charCodeAt(this.index))) this.fail("invalid fractional number");
      while (isDigit(this.text.charCodeAt(this.index))) this.index += 1;
    }
    if (this.peek() === "e" || this.peek() === "E") {
      this.index += 1;
      if (this.peek() === "+" || this.peek() === "-") this.index += 1;
      if (!isDigit(this.text.charCodeAt(this.index))) this.fail("invalid exponent");
      while (isDigit(this.text.charCodeAt(this.index))) this.index += 1;
    }
    if (this.index === start) this.fail("invalid number");
  }

  private skipWhitespace(): void {
    while (true) {
      const code = this.text.charCodeAt(this.index);
      if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) this.index += 1;
      else return;
    }
  }

  private consume(expected: string): void {
    if (!this.consumeIf(expected)) this.fail(`expected ${expected}`);
  }

  private consumeIf(expected: string): boolean {
    if (this.peek() !== expected) return false;
    this.index += 1;
    return true;
  }

  private peek(): string | undefined {
    return this.index < this.text.length ? this.text[this.index] : undefined;
  }

  private fail(reason: string): never {
    throw new ManagerStrictJsonError(`${this.label} is invalid JSON: ${reason}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function isHexDigit(code: number): boolean {
  return isDigit(code) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
