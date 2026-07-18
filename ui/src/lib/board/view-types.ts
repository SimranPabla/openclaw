import type { BoardOp, BoardSnapshot, BoardTab, BoardWidget } from "@openclaw/gateway-protocol";

export type { BoardOp, BoardSnapshot, BoardTab, BoardWidget };
export type BoardGrantDecision = "granted" | "rejected";

export type BoardViewCallbacks = {
  applyOps: (ops: BoardOp[]) => Promise<void>;
  grant: (name: string, decision: BoardGrantDecision) => Promise<void>;
  selectTab: (tabId: string) => void;
  frameLoadFailed?: (name: string) => Promise<void>;
};

export type BoardWidgetFrameUrl = (name: string, revision: number) => string;
