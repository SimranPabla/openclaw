// Narrow base64 media-source helpers for plugins that do not need the broad media runtime.

export {
  canonicalizeBase64,
  estimateBase64DecodedBytes,
  parseBase64Source,
  type ParsedBase64Source,
} from "@openclaw/media-core/base64";
