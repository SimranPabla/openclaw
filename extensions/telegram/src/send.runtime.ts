// Telegram plugin module implements send behavior.
export { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
export { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
export type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
export { kindFromMime, type MediaKind } from "openclaw/plugin-sdk/media-mime";
export type { PollInput } from "openclaw/plugin-sdk/media-runtime";
export {
  buildOutboundMediaLoadOptions,
  getImageMetadata,
  isGifMedia,
  normalizePollInput,
  probeVideoDimensions,
} from "openclaw/plugin-sdk/media-runtime";
export { loadWebMedia } from "openclaw/plugin-sdk/web-media";
