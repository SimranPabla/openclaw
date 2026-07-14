export type ParsedBase64Source =
  | { kind: "raw"; payload: string }
  | { kind: "data-url"; mediaType?: string; payload: string };

const DATA_URL_MIME_TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function isValidDataUrlMediaType(value: string): boolean {
  if (!value) {
    return true;
  }
  const parts = value.split("/");
  return (
    parts.length === 2 &&
    parts[0] !== undefined &&
    DATA_URL_MIME_TOKEN_RE.test(parts[0]) &&
    parts[1] !== undefined &&
    DATA_URL_MIME_TOKEN_RE.test(parts[1])
  );
}

function isValidDataUrlParameter(value: string): boolean {
  const equalsIndex = value.indexOf("=");
  if (equalsIndex <= 0 || equalsIndex === value.length - 1) {
    return false;
  }
  return (
    DATA_URL_MIME_TOKEN_RE.test(value.slice(0, equalsIndex)) &&
    DATA_URL_MIME_TOKEN_RE.test(value.slice(equalsIndex + 1))
  );
}

function findTrimmedBounds(value: string): { start: number; end: number } {
  let start = 0;
  while (start < value.length && value.charCodeAt(start) <= 0x20) {
    start += 1;
  }
  let end = value.length;
  while (end > start && value.charCodeAt(end - 1) <= 0x20) {
    end -= 1;
  }
  return { start, end };
}

/** Extracts raw base64 or the payload of a base64 data URL without decoding it. */
export function parseBase64Source(value: string): ParsedBase64Source | undefined {
  const { start, end } = findTrimmedBounds(value);
  if (value.slice(start, start + 5).toLowerCase() !== "data:") {
    return { kind: "raw", payload: value };
  }
  const commaIndex = value.indexOf(",", start + 5);
  if (commaIndex < 0 || commaIndex >= end) {
    return undefined;
  }
  const metadata = value.slice(start + 5, commaIndex).split(";");
  const [mediaType, ...options] = metadata;
  const parameters = options.slice(0, -1);
  if (
    mediaType === undefined ||
    !isValidDataUrlMediaType(mediaType) ||
    options.at(-1)?.toLowerCase() !== "base64" ||
    options.filter((part) => part.toLowerCase() === "base64").length !== 1 ||
    parameters.some((part) => !isValidDataUrlParameter(part))
  ) {
    return undefined;
  }
  return {
    kind: "data-url",
    ...(mediaType ? { mediaType } : {}),
    payload: value.slice(commaIndex + 1, end),
  };
}

/** Estimates decoded bytes without allocating a cleaned copy of the base64 payload. */
export function estimateBase64DecodedBytes(base64: string): number {
  // Avoid `trim()`/`replace()` here: they allocate a second (potentially huge) string.
  // We only need a conservative decoded-size estimate to enforce budgets before Buffer.from(..., "base64").
  let effectiveLen = 0;
  for (let i = 0; i < base64.length; i += 1) {
    const code = base64.charCodeAt(i);
    // Treat ASCII control + space as whitespace; base64 decoders commonly ignore these.
    if (code <= 0x20) {
      continue;
    }
    effectiveLen += 1;
  }

  if (effectiveLen === 0) {
    return 0;
  }

  let padding = 0;
  // Find last non-whitespace char(s) to detect '=' padding without allocating/copying.
  let end = base64.length - 1;
  while (end >= 0 && base64.charCodeAt(end) <= 0x20) {
    end -= 1;
  }
  if (end >= 0 && base64[end] === "=") {
    padding = 1;
    end -= 1;
    while (end >= 0 && base64.charCodeAt(end) <= 0x20) {
      end -= 1;
    }
    if (end >= 0 && base64[end] === "=") {
      padding = 2;
    }
  }

  const estimated = Math.floor((effectiveLen * 3) / 4) - padding;
  return Math.max(0, estimated);
}

const CANONICALIZE_BASE64_CHUNK_SIZE = 8192;

function isBase64DataChar(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x2b ||
    code === 0x2f
  );
}

/**
 * Normalizes and validates a base64 string, returning canonical no-whitespace
 * base64 only when the input has valid alphabet, padding, and length.
 */
export function canonicalizeBase64(base64: string): string | undefined {
  const chunks: string[] = [];
  let current = "";
  let cleanedLength = 0;
  let padding = 0;
  let sawPadding = false;

  const append = (char: string): void => {
    current += char;
    cleanedLength += 1;
    if (current.length >= CANONICALIZE_BASE64_CHUNK_SIZE) {
      chunks.push(current);
      current = "";
    }
  };

  for (let i = 0; i < base64.length; i += 1) {
    const code = base64.charCodeAt(i);
    if (code <= 0x20) {
      continue;
    }
    if (code === 0x3d) {
      padding += 1;
      if (padding > 2) {
        return undefined;
      }
      sawPadding = true;
      append("=");
      continue;
    }
    if (sawPadding || !isBase64DataChar(code)) {
      return undefined;
    }
    append(base64[i] ?? "");
  }
  if (cleanedLength === 0) {
    return undefined;
  }
  const remainder = cleanedLength % 4;
  if (remainder !== 0) {
    if (sawPadding || remainder === 1) {
      return undefined;
    }
    current += "=".repeat(4 - remainder);
  }
  if (current) {
    chunks.push(current);
  }
  return chunks.join("");
}
