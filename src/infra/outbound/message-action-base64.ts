// Shared base64 attachment parsing and size enforcement for message actions.
import {
  canonicalizeBase64,
  estimateBase64DecodedBytes,
  parseBase64Source,
} from "@openclaw/media-core/base64";

export function normalizeBase64Payload(params: { base64?: string; contentType?: string }): {
  base64?: string;
  contentType?: string;
} {
  if (!params.base64) {
    return { base64: params.base64, contentType: params.contentType };
  }
  const source = parseBase64Source(params.base64);
  if (!source) {
    throw new Error("message action buffer has invalid base64 data");
  }
  return {
    base64: source.payload,
    contentType: params.contentType ?? (source.kind === "data-url" ? source.mediaType : undefined),
  };
}

export function canonicalizeBase64Attachment(params: {
  base64: string;
  maxBytes?: number;
}): string {
  if (params.maxBytes !== undefined) {
    const estimatedBytes = estimateBase64DecodedBytes(params.base64);
    if (estimatedBytes > params.maxBytes) {
      throw new Error(`Media too large: ${estimatedBytes} bytes (limit: ${params.maxBytes} bytes)`);
    }
  }
  const canonicalBase64 = canonicalizeBase64(params.base64);
  if (!canonicalBase64) {
    throw new Error("message action buffer has invalid base64 data");
  }
  return canonicalBase64;
}

export function decodeBoundedBase64Attachment(params: {
  base64: string;
  maxBytes: number;
}): Buffer {
  const canonicalBase64 = canonicalizeBase64Attachment(params);
  const buffer = Buffer.from(canonicalBase64, "base64");
  if (buffer.byteLength > params.maxBytes) {
    throw new Error(
      `Media too large: ${buffer.byteLength} bytes (limit: ${params.maxBytes} bytes)`,
    );
  }
  return buffer;
}
