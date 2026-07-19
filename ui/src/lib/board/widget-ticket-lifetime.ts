import type { BoardWidget } from "@openclaw/gateway-protocol";

const ticketReceivedAtMs = new WeakMap<BoardWidget, number>();

export function recordBoardWidgetTicketReceipt(
  widget: BoardWidget,
  receivedAtMs = Date.now(),
): void {
  if (widget.viewTicket && widget.viewTicketTtlMs) {
    ticketReceivedAtMs.set(widget, receivedAtMs);
  }
}

export function copyBoardWidgetTicketReceipt(
  widget: BoardWidget,
  previous: BoardWidget,
  fallbackReceivedAtMs = Date.now(),
): void {
  if (widget.viewTicket && widget.viewTicketTtlMs) {
    ticketReceivedAtMs.set(widget, ticketReceivedAtMs.get(previous) ?? fallbackReceivedAtMs);
  }
}

export function remainingBoardWidgetTicketTtlMs(
  widget: BoardWidget,
  nowMs = Date.now(),
): number | undefined {
  const ttlMs = widget.viewTicketTtlMs;
  if (!widget.viewTicket || !ttlMs) {
    return undefined;
  }
  const receivedAtMs = ticketReceivedAtMs.get(widget);
  return receivedAtMs === undefined ? ttlMs : Math.max(0, ttlMs - (nowMs - receivedAtMs));
}
