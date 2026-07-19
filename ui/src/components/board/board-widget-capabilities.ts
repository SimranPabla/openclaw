import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../i18n/index.ts";
import type { BoardWidget } from "../../lib/board/view-types.ts";

export function renderBoardGrantedCapabilities(
  widget: BoardWidget,
): TemplateResult | typeof nothing {
  if (widget.grantState !== "granted" || !widget.declared) {
    return nothing;
  }
  const capabilities = [
    ...(widget.declared.netOrigins ?? []).map((origin) =>
      t("board.widget.networkCapability", { capability: origin }),
    ),
    ...(widget.declared.tools ?? []).map((tool) =>
      t("board.widget.toolCapability", { capability: tool }),
    ),
  ];
  if (capabilities.length === 0) {
    return nothing;
  }
  return html`
    <openclaw-tooltip
      .content=${`${t("board.widget.activeCapabilities")}\n${capabilities.join("\n")}`}
    >
      <span class="board-widget__capabilities" data-test-id="board-capabilities-granted">
        ${t("board.widget.granted")}
      </span>
    </openclaw-tooltip>
  `;
}
