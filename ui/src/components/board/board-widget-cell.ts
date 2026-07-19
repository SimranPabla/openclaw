import { consume } from "@lit/context";
import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import type { BoardGridDirection, BoardGridRect } from "../../lib/board/grid.ts";
import { toCssPlacement } from "../../lib/board/grid.ts";
import type {
  BoardGrantDecision,
  BoardTab,
  BoardWidget,
  BoardWidgetFrameUrl,
} from "../../lib/board/view-types.ts";
import { BoardWidgetSandboxHost } from "../../lib/board/widget-sandbox-host.ts";
import { remainingBoardWidgetTicketTtlMs } from "../../lib/board/widget-ticket-lifetime.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { resolveGatewayHttpOrigin, resolveSandboxHostUrl } from "../sandbox-host.ts";
import { renderBoardGrantedCapabilities } from "./board-widget-capabilities.ts";
import "../tooltip.ts";
import "../web-awesome.ts";

const BOARD_SIZE_PRESETS = {
  sm: { w: 3, h: 3 },
  md: { w: 6, h: 4 },
  lg: { w: 8, h: 6 },
  xl: { w: 12, h: 8 },
} as const;
const MAX_FRAME_REFRESH_ATTEMPTS = 3;
const VIEW_TICKET_REFRESH_LEAD_MS = 15_000;
const VIEW_TICKET_REFRESH_MIN_DELAY_MS = 1_000;
const VIEW_TICKET_REFRESH_RETRY_MS = 1_000;
const VIEW_TICKET_REFRESH_MAX_RETRY_MS = 30_000;

export type BoardWidgetCellCallbacks = {
  grant: (name: string, decision: BoardGrantDecision) => Promise<void>;
  movePointerDown: (widget: BoardWidget, event: PointerEvent) => void;
  resizePointerDown: (widget: BoardWidget, event: PointerEvent) => void;
  moveToTab: (widget: BoardWidget, tabId: string) => Promise<void>;
  resizeTo: (widget: BoardWidget, w: number, h: number) => Promise<void>;
  remove: (widget: BoardWidget) => Promise<void>;
  nudge: (widget: BoardWidget, direction: BoardGridDirection) => Promise<void>;
  focus: (widget: BoardWidget, direction: BoardGridDirection) => void;
  focusChanged: (name: string) => void;
  frameLoadFailed: (name: string) => Promise<void>;
};

class OpenClawBoardWidgetCell extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;

  @property({ attribute: false }) widget?: BoardWidget;
  @property({ attribute: false }) rect?: BoardGridRect;
  @property({ attribute: false }) tabs: readonly BoardTab[] = [];
  @property({ attribute: false }) widgetFrameUrl?: BoardWidgetFrameUrl;
  @property({ attribute: false }) callbacks?: BoardWidgetCellCallbacks;
  @property({ type: Boolean }) dragging = false;
  @property({ type: Number }) focusTabIndex = -1;
  @property({ type: Number }) positionInSet = 1;
  @property({ type: Number }) setSize = 1;
  @property({ type: Boolean }) busy = false;

  @state() private actionError = "";
  @state() private actionPending = false;
  @state() private frameError = "";
  private frameFailureKey = "";
  private frameRefreshAttempts = 0;
  private frameProbeGeneration = 0;
  private lastFrameUrl = "";
  private sandboxOrigin = "";
  private sandboxContext?: ApplicationContext;
  private sandboxHost: BoardWidgetSandboxHost | null = null;
  private ticketRefreshTimer: number | null = null;
  private ticketRefreshAttempts = 0;
  private scheduledTicket = "";

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("message", this.handleSandboxMessage);
  }

  override disconnectedCallback(): void {
    window.removeEventListener("message", this.handleSandboxMessage);
    this.clearTicketRefresh();
    this.sandboxHost?.dispose();
    this.sandboxHost = null;
    super.disconnectedCallback();
  }

  override willUpdate(changed: PropertyValues<this>): void {
    const previousWidget = changed.get("widget");
    if (previousWidget && previousWidget !== this.widget) {
      this.actionError = "";
      if (
        previousWidget.name !== this.widget?.name ||
        previousWidget.revision !== this.widget?.revision
      ) {
        this.resetFrameFailures();
      } else if (this.widget && this.frameError) {
        const nextFrameUrl = this.widgetFrameUrl?.(this.widget.name, this.widget.revision) ?? "";
        if (nextFrameUrl && nextFrameUrl !== this.lastFrameUrl) {
          // A newly minted ticket gets one authorization probe, but keeps the
          // existing remint budget until that probe proves the frame healthy.
          this.frameError = "";
        }
      }
    }
  }

  override updated(changed: PropertyValues): void {
    const contextChanged = this.sandboxContext !== this.context;
    if (
      changed.has("widget") ||
      changed.has("callbacks") ||
      contextChanged ||
      changed.has("widgetFrameUrl")
    ) {
      // Context subscriptions request an update without registering a Lit
      // property change. Track identity explicitly so reconnects replace the
      // Gateway client behind an already-adopted private bridge port.
      this.sandboxContext = this.context;
      this.scheduleTicketRefresh();
      this.updateSandboxHost();
    }
  }

  private clearTicketRefresh(): void {
    if (this.ticketRefreshTimer !== null) {
      window.clearTimeout(this.ticketRefreshTimer);
      this.ticketRefreshTimer = null;
    }
  }

  private scheduleTicketRefresh(): void {
    const widget = this.widget;
    const callbacks = this.callbacks;
    const ticket = widget?.viewTicket;
    const remainingTtlMs = widget ? remainingBoardWidgetTicketTtlMs(widget) : undefined;
    if (!widget || !callbacks || !ticket || remainingTtlMs === undefined) {
      this.clearTicketRefresh();
      this.ticketRefreshAttempts = 0;
      this.scheduledTicket = "";
      return;
    }
    if (this.scheduledTicket === ticket) {
      return;
    }
    this.clearTicketRefresh();
    this.ticketRefreshAttempts = 0;
    this.scheduledTicket = ticket;
    const delayMs = Math.max(
      VIEW_TICKET_REFRESH_MIN_DELAY_MS,
      remainingTtlMs - VIEW_TICKET_REFRESH_LEAD_MS,
    );
    this.ticketRefreshTimer = window.setTimeout(() => {
      this.ticketRefreshTimer = null;
      this.refreshTicket(widget, callbacks, ticket);
    }, delayMs);
  }

  private refreshTicket(
    widget: BoardWidget,
    callbacks: BoardWidgetCellCallbacks,
    ticket: string,
  ): void {
    if (this.widget?.viewTicket !== ticket || this.scheduledTicket !== ticket) {
      return;
    }
    this.ticketRefreshAttempts += 1;
    void callbacks.frameLoadFailed(widget.name).catch(() => {
      if (this.widget?.viewTicket !== ticket || this.scheduledTicket !== ticket) {
        return;
      }
      // Ticket refresh is proactive. Keep the loaded widget usable and retry
      // transient gateway failures without turning them into a frame failure.
      this.clearTicketRefresh();
      this.ticketRefreshTimer = window.setTimeout(
        () => {
          this.ticketRefreshTimer = null;
          this.refreshTicket(widget, callbacks, ticket);
        },
        Math.min(
          VIEW_TICKET_REFRESH_RETRY_MS * this.ticketRefreshAttempts,
          VIEW_TICKET_REFRESH_MAX_RETRY_MS,
        ),
      );
    });
  }

  private resetFrameFailures(): void {
    this.frameProbeGeneration += 1;
    this.frameFailureKey = "";
    this.frameRefreshAttempts = 0;
    this.frameError = "";
    this.sandboxHost?.reset();
  }

  private closeMenu(): void {
    const menu = this.querySelector<HTMLElement & { open: boolean }>(".board-widget__menu");
    if (menu) {
      menu.open = false;
    }
  }

  private async runAction(action: () => Promise<void>): Promise<void> {
    if (this.actionPending || this.busy) {
      return;
    }
    this.actionPending = true;
    this.actionError = "";
    this.closeMenu();
    try {
      await action();
    } catch (error) {
      this.actionError = error instanceof Error ? error.message : String(error);
    } finally {
      this.actionPending = false;
    }
  }

  private handleMenuSelect(
    event: CustomEvent<{ item: { value?: string } }>,
    widget: BoardWidget,
    callbacks: BoardWidgetCellCallbacks,
  ): void {
    const value = event.detail.item.value;
    if (value === "remove") {
      void this.runAction(() => callbacks.remove(widget));
      return;
    }
    if (value?.startsWith("move:")) {
      void this.runAction(() => callbacks.moveToTab(widget, value.slice("move:".length)));
      return;
    }
    if (value?.startsWith("resize:")) {
      const preset = value.slice("resize:".length) as keyof typeof BOARD_SIZE_PRESETS;
      const size = BOARD_SIZE_PRESETS[preset];
      if (size) {
        void this.runAction(() => callbacks.resizeTo(widget, size.w, size.h));
      }
    }
  }

  private renderMenu(widget: BoardWidget, callbacks: BoardWidgetCellCallbacks): TemplateResult {
    const otherTabs = this.tabs.filter((tab) => tab.tabId !== widget.tabId);
    return html`
      <wa-dropdown
        class="board-widget__menu"
        placement="bottom-end"
        @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) =>
          this.handleMenuSelect(event, widget, callbacks)}
      >
        <button
          class="board-widget__menu-trigger"
          slot="trigger"
          type="button"
          aria-label=${t("board.widget.menuLabel")}
          title=${t("board.widget.menuLabel")}
        >
          ⋮
        </button>
        <div class="board-widget__menu-heading">${t("board.widget.moveToTab")}</div>
        ${otherTabs.length > 0
          ? otherTabs.map(
              (tab) => html`
                <wa-dropdown-item
                  value=${`move:${tab.tabId}`}
                  ?disabled=${this.busy || this.actionPending}
                >
                  ${tab.title}
                </wa-dropdown-item>
              `,
            )
          : html`<span class="board-widget__menu-empty">${t("board.widget.noOtherTabs")}</span>`}
        <div class="board-widget__menu-heading">${t("board.widget.resize")}</div>
        ${Object.entries(BOARD_SIZE_PRESETS).map(
          ([label, size]) => html`
            <wa-dropdown-item
              class="board-widget__preset"
              value=${`resize:${label}`}
              ?disabled=${this.busy || this.actionPending}
            >
              ${label.toUpperCase()}
              <span slot="details">${size.w}×${size.h}</span>
            </wa-dropdown-item>
          `,
        )}
        <div class="board-widget__menu-separator" role="separator"></div>
        <wa-dropdown-item
          class="board-widget__menu-danger"
          value="remove"
          ?disabled=${this.busy || this.actionPending}
        >
          ${t("board.widget.remove")}
        </wa-dropdown-item>
      </wa-dropdown>
    `;
  }

  private renderPending(widget: BoardWidget, callbacks: BoardWidgetCellCallbacks): TemplateResult {
    const netOrigins = widget.declared?.netOrigins ?? [];
    const tools = widget.declared?.tools ?? [];
    return html`
      <div class="board-widget__grant board-widget__grant--pending" data-test-id="board-pending">
        <div class="board-widget__grant-mark" aria-hidden="true">!</div>
        <strong>${t("board.widget.needsApproval")}</strong>
        ${netOrigins.length > 0 || tools.length > 0
          ? html`<div class="board-widget__grant-groups">
              ${netOrigins.length > 0
                ? html`<section>
                    <strong>${t("board.widget.networkAccess")}</strong>
                    <ul class="board-widget__grant-summary">
                      ${netOrigins.map((origin) => html`<li>${origin}</li>`)}
                    </ul>
                  </section>`
                : nothing}
              ${tools.length > 0
                ? html`<section>
                    <strong>${t("board.widget.hostTools")}</strong>
                    <ul class="board-widget__grant-summary">
                      ${tools.map((tool) => html`<li>${tool}</li>`)}
                    </ul>
                  </section>`
                : nothing}
            </div>`
          : widget.declaredSummary?.length
            ? html`<ul class="board-widget__grant-summary">
                ${widget.declaredSummary.map((summary) => html`<li>${summary}</li>`)}
              </ul>`
            : html`<span>${t("board.widget.needsApprovalDetail")}</span>`}
        <div class="board-widget__grant-actions">
          <button
            class="btn btn--small btn--primary"
            type="button"
            data-test-id="board-grant-allow"
            ?disabled=${this.busy || this.actionPending}
            @click=${() => void this.runAction(() => callbacks.grant(widget.name, "granted"))}
          >
            ${t("board.widget.allow")}
          </button>
          <button
            class="btn btn--small"
            type="button"
            data-test-id="board-grant-reject"
            ?disabled=${this.busy || this.actionPending}
            @click=${() => void this.runAction(() => callbacks.grant(widget.name, "rejected"))}
          >
            ${t("board.widget.reject")}
          </button>
        </div>
        ${this.actionError ? this.renderActionError(this.actionError, true) : nothing}
      </div>
    `;
  }

  private renderRejected(widget: BoardWidget, callbacks: BoardWidgetCellCallbacks): TemplateResult {
    return html`
      <div class="board-widget__grant board-widget__grant--rejected" data-test-id="board-rejected">
        <strong>${t("board.widget.rejected")}</strong>
        <span>${t("board.widget.rejectedDetail")}</span>
        <button
          class="btn btn--small"
          type="button"
          ?disabled=${this.busy || this.actionPending}
          @click=${() => void this.runAction(() => callbacks.remove(widget))}
        >
          ${t("board.widget.remove")}
        </button>
      </div>
    `;
  }

  private refreshFailedFrame(widget: BoardWidget, callbacks: BoardWidgetCellCallbacks): void {
    this.frameProbeGeneration += 1;
    const failureKey = `${widget.name}:${widget.revision}`;
    if (this.frameFailureKey !== failureKey) {
      this.resetFrameFailures();
      this.frameFailureKey = failureKey;
    }
    if (this.frameRefreshAttempts >= MAX_FRAME_REFRESH_ATTEMPTS) {
      this.frameError = t("board.widget.frameAuthorizationFailed");
      return;
    }
    this.frameRefreshAttempts += 1;
    void callbacks.frameLoadFailed(widget.name).catch((error: unknown) => {
      this.frameError = error instanceof Error ? error.message : String(error);
    });
    if (this.frameRefreshAttempts >= MAX_FRAME_REFRESH_ATTEMPTS) {
      this.frameError = t("board.widget.frameAuthorizationFailed");
    }
  }

  private verifyFrameAuthorization(
    event: Event,
    widget: BoardWidget,
    callbacks: BoardWidgetCellCallbacks,
  ): void {
    const frame = event.currentTarget;
    const src = frame instanceof HTMLIFrameElement ? (frame.getAttribute("src") ?? "") : "";
    if (!src.startsWith("/__openclaw__/board/")) {
      return;
    }
    const probeGeneration = this.frameProbeGeneration + 1;
    this.frameProbeGeneration = probeGeneration;
    const isCurrentProbe = () =>
      frame instanceof HTMLIFrameElement &&
      frame.isConnected &&
      frame.getAttribute("src") === src &&
      this.frameProbeGeneration === probeGeneration &&
      this.widget?.name === widget.name &&
      this.widget.revision === widget.revision;
    // View tickets are reusable HMAC bindings until expiry. Iframe load events
    // hide HTTP status, so a credentialed probe is the only 401 signal.
    void fetch(src, { cache: "no-store" })
      .then((response) => {
        if (!isCurrentProbe()) {
          return;
        }
        if (response.status === 401) {
          this.refreshFailedFrame(widget, callbacks);
        } else if (response.ok) {
          this.resetFrameFailures();
        }
      })
      .catch(() => {
        if (isCurrentProbe()) {
          this.refreshFailedFrame(widget, callbacks);
        }
      });
  }

  private resolveSandboxFrameUrl(widget: BoardWidget): string | undefined {
    const gatewayUrl = this.context?.gateway.connection.gatewayUrl;
    if (
      !widget.sandboxUrl ||
      !widget.sandboxPort ||
      !widget.viewTicket ||
      gatewayUrl === undefined
    ) {
      return undefined;
    }
    const url = resolveSandboxHostUrl(
      widget.sandboxUrl,
      widget.sandboxPort,
      widget.sandboxOrigin,
      gatewayUrl,
      window.location.origin,
    );
    this.sandboxOrigin = new URL(url).origin;
    return url;
  }

  private sandboxHostOptions(
    frame: HTMLIFrameElement,
    widget: BoardWidget,
    callbacks: BoardWidgetCellCallbacks,
  ): ConstructorParameters<typeof BoardWidgetSandboxHost>[0] | undefined {
    if (!this.widgetFrameUrl) {
      return undefined;
    }
    return {
      frame,
      widget,
      sandboxOrigin: this.sandboxOrigin,
      sandboxUrl: frame.src,
      sourceOrigin: resolveGatewayHttpOrigin(
        this.context?.gateway.connection.gatewayUrl ?? "",
        window.location.origin,
      ),
      client: this.context?.gateway.snapshot.client ?? undefined,
      resolveFrameUrl: this.widgetFrameUrl,
      confirmPrompt: (prompt) => window.confirm(`${t("common.confirm")}:\n\n${prompt}`),
      onFrameUrl: (url) => {
        this.lastFrameUrl = url;
      },
      onUnauthorized: (currentWidget) => this.refreshFailedFrame(currentWidget, callbacks),
      onReadyTimeout: () => this.refreshFailedFrame(widget, callbacks),
      onLoaded: () => {
        this.frameFailureKey = "";
        this.frameRefreshAttempts = 0;
        this.frameError = "";
      },
      onError: (error) => {
        this.frameError = error instanceof Error ? error.message : String(error);
      },
    };
  }

  private updateSandboxHost(): void {
    const frame = this.querySelector<HTMLIFrameElement>(".board-widget__frame");
    const widget = this.widget;
    const callbacks = this.callbacks;
    if (
      !frame?.isConnected ||
      !widget ||
      !callbacks ||
      !widget.sandboxUrl ||
      !widget.sandboxPort ||
      !widget.viewTicket
    ) {
      this.sandboxHost?.dispose();
      this.sandboxHost = null;
      return;
    }
    const options = this.sandboxHostOptions(frame, widget, callbacks);
    if (!options) {
      return;
    }
    if (!this.sandboxHost || this.sandboxHost.frame !== frame) {
      this.sandboxHost?.dispose();
      this.sandboxHost = new BoardWidgetSandboxHost(options);
    } else {
      this.sandboxHost.update(options);
    }
  }

  private handleSandboxMessage = (event: MessageEvent): void => {
    const frame = this.querySelector<HTMLIFrameElement>(".board-widget__frame");
    const widget = this.widget;
    const callbacks = this.callbacks;
    if (
      !frame ||
      !widget ||
      !callbacks ||
      !widget.viewTicket ||
      event.source !== frame.contentWindow ||
      event.origin !== this.sandboxOrigin
    ) {
      return;
    }
    const options = this.sandboxHostOptions(frame, widget, callbacks);
    if (!options) {
      return;
    }
    if (!this.sandboxHost || this.sandboxHost.frame !== frame) {
      this.sandboxHost?.dispose();
      this.sandboxHost = new BoardWidgetSandboxHost(options);
    } else {
      this.sandboxHost.update(options);
    }
    this.sandboxHost.handleMessage(event);
  };

  private renderFrame(widget: BoardWidget, callbacks: BoardWidgetCellCallbacks): TemplateResult {
    if (!this.widgetFrameUrl) {
      throw new Error(t("board.widget.frameResolverMissing"));
    }
    const src = this.widgetFrameUrl(widget.name, widget.revision);
    this.lastFrameUrl = src;
    const sandboxSrc = this.resolveSandboxFrameUrl(widget);
    if (sandboxSrc) {
      return html`
        <iframe
          class="board-widget__frame"
          sandbox="allow-scripts allow-same-origin allow-forms"
          referrerpolicy="origin"
          loading="eager"
          title=${widget.title || widget.name}
          src=${sandboxSrc}
          @error=${() => {
            if (this.sandboxHost) {
              this.sandboxHost.handleFrameError();
            } else {
              this.refreshFailedFrame(widget, callbacks);
            }
          }}
        ></iframe>
      `;
    }
    if (widget.sandboxUrl || widget.sandboxPort || widget.viewTicket) {
      throw new Error(t("board.widget.sandboxUnavailable"));
    }
    // Snapshots from hosts predating the shared-sandbox contract remain capless:
    // no bridge ticket or network CSP authority crosses this compatibility path.
    return html`
      <iframe
        class="board-widget__frame"
        sandbox="allow-scripts"
        referrerpolicy="no-referrer"
        loading="lazy"
        title=${widget.title || widget.name}
        src=${src}
        @error=${() => this.refreshFailedFrame(widget, callbacks)}
        @load=${(event: Event) => this.verifyFrameAuthorization(event, widget, callbacks)}
      ></iframe>
    `;
  }

  private renderBody(widget: BoardWidget, callbacks: BoardWidgetCellCallbacks): TemplateResult {
    if (widget.grantState === "pending") {
      return this.renderPending(widget, callbacks);
    }
    if (widget.grantState === "rejected") {
      return this.renderRejected(widget, callbacks);
    }
    return this.renderFrame(widget, callbacks);
  }

  private renderError(error: unknown): TemplateResult {
    const message = error instanceof Error ? error.message : String(error);
    return html`
      <div class="board-widget__error" role="alert" data-test-id="board-widget-error">
        <strong>${t("board.widget.errorTitle")}</strong>
        <span>${t("board.widget.errorDetail")}</span>
        <details>
          <summary>${t("board.widget.errorShow")}</summary>
          <code>${message}</code>
        </details>
      </div>
    `;
  }

  private renderActionError(error: string, inline = false): TemplateResult {
    return html`
      <div
        class=${`board-widget__error ${inline ? "board-widget__error--inline" : ""}`}
        role="alert"
        data-test-id="board-widget-action-error"
      >
        <strong>${t("board.widget.actionErrorTitle")}</strong>
        <span>${t("board.widget.actionErrorDetail")}</span>
        <details>
          <summary>${t("board.widget.errorShow")}</summary>
          <code>${error}</code>
        </details>
      </div>
    `;
  }

  private handleKeyDown(
    event: KeyboardEvent,
    widget: BoardWidget,
    callbacks: BoardWidgetCellCallbacks,
  ): void {
    if (event.target !== event.currentTarget) {
      return;
    }
    const direction =
      event.key === "ArrowLeft"
        ? "left"
        : event.key === "ArrowRight"
          ? "right"
          : event.key === "ArrowUp"
            ? "up"
            : event.key === "ArrowDown"
              ? "down"
              : null;
    if (!direction) {
      return;
    }
    event.preventDefault();
    if (event.altKey) {
      void this.runAction(() => callbacks.nudge(widget, direction));
    } else {
      callbacks.focus(widget, direction);
    }
  }

  override render() {
    const widget = this.widget;
    const rect = this.rect;
    const callbacks = this.callbacks;
    if (!widget || !rect || !callbacks) {
      return nothing;
    }
    let body: TemplateResult;
    let bodyErrored: boolean;
    try {
      body = this.frameError
        ? this.renderError(this.frameError)
        : this.renderBody(widget, callbacks);
      bodyErrored = Boolean(this.frameError);
    } catch (error) {
      body = this.renderError(error);
      bodyErrored = true;
    }
    const label = widget.title || widget.name;
    const bodyScrollable =
      bodyErrored ||
      this.actionError !== "" ||
      widget.grantState === "pending" ||
      widget.grantState === "rejected";
    return html`
      <section
        class=${`board-widget ${this.dragging ? "board-widget--dragging" : ""}`}
        style=${toCssPlacement(rect)}
        role="listitem"
        tabindex=${this.focusTabIndex}
        aria-posinset=${this.positionInSet}
        aria-setsize=${this.setSize}
        aria-label=${t("board.widget.cellLabel", { title: label })}
        data-widget-name=${widget.name}
        data-test-id="board-widget"
        @focus=${() => callbacks.focusChanged(widget.name)}
        @keydown=${(event: KeyboardEvent) => this.handleKeyDown(event, widget, callbacks)}
      >
        <header class="board-widget__bar">
          <span
            class="board-widget__drag-handle"
            aria-hidden="true"
            title=${t("board.widget.moveHandle", { title: label })}
            @pointerdown=${(event: PointerEvent) => callbacks.movePointerDown(widget, event)}
          >
            <span aria-hidden="true">⠿</span>
          </span>
          <span class="board-widget__title" title=${label}>${label}</span>
          <span class="board-widget__kind"
            >${widget.contentKind === "mcp-app"
              ? t("board.widget.kindMcp")
              : t("board.widget.kindHtml")}</span
          >
          ${renderBoardGrantedCapabilities(widget)} ${this.renderMenu(widget, callbacks)}
        </header>
        <div
          class=${`board-widget__body ${bodyScrollable ? "board-widget__body--scrollable" : ""}`}
        >
          ${body}
          ${this.actionError && widget.grantState !== "pending"
            ? html`<div class="board-widget__error-overlay">
                ${this.renderActionError(this.actionError)}
              </div>`
            : nothing}
        </div>
        <span
          class="board-widget__resize-handle"
          aria-hidden="true"
          title=${t("board.widget.resizeHandle", { title: label })}
          @pointerdown=${(event: PointerEvent) => callbacks.resizePointerDown(widget, event)}
        ></span>
      </section>
    `;
  }
}

if (!customElements.get("openclaw-board-widget-cell")) {
  customElements.define("openclaw-board-widget-cell", OpenClawBoardWidgetCell);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-board-widget-cell": OpenClawBoardWidgetCell;
  }
}
