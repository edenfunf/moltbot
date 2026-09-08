import { vi } from "vitest";
import type { OpenClawConfig, PluginRuntime } from "../api.js";
import { createLineSendReceipt } from "./send-receipt.js";

type LineRuntimeMocks = {
  pushMessageLine: ReturnType<typeof vi.fn>;
  pushMessagesLine: ReturnType<typeof vi.fn>;
  createQuickReplyItems: ReturnType<typeof vi.fn>;
  buildTemplateMessageFromPayload: ReturnType<typeof vi.fn>;
  chunkMarkdownText: ReturnType<typeof vi.fn>;
  resolveLineAccount: ReturnType<typeof vi.fn>;
  resolveTextChunkLimit: ReturnType<typeof vi.fn>;
};

export function lineResult(messageId: string, chatId = "c1") {
  return {
    messageId,
    chatId,
    receipt: createLineSendReceipt({ messageId, chatId, kind: "text" }),
  };
}

export function createRuntime(): { runtime: PluginRuntime; mocks: LineRuntimeMocks } {
  const pushMessageLine = vi.fn(async () => lineResult("m-text"));
  const pushMessagesLine = vi.fn(async () => lineResult("m-batch"));
  const createQuickReplyItems = vi.fn((labels: string[]) => ({ items: labels }));
  const buildTemplateMessageFromPayload = vi.fn(() => ({ type: "buttons" }));
  const chunkMarkdownText = vi.fn((text: string) => [text]);
  const resolveTextChunkLimit = vi.fn(() => 123);
  const resolveLineAccount = vi.fn(
    ({ cfg, accountId }: { cfg: OpenClawConfig; accountId?: string }) => {
      const resolved = accountId ?? "default";
      const lineConfig = (cfg.channels?.line ?? {}) as {
        accounts?: Record<string, Record<string, unknown>>;
      };
      const accountConfig = resolved !== "default" ? (lineConfig.accounts?.[resolved] ?? {}) : {};
      return {
        accountId: resolved,
        config: { ...lineConfig, ...accountConfig },
      };
    },
  );

  const runtime = {
    channel: {
      line: {
        pushMessageLine,
        pushMessagesLine,
        createQuickReplyItems,
        buildTemplateMessageFromPayload,
        resolveLineAccount,
      },
      text: {
        chunkMarkdownText,
        resolveTextChunkLimit,
      },
    },
  } as unknown as PluginRuntime;

  return {
    runtime,
    mocks: {
      pushMessageLine,
      pushMessagesLine,
      createQuickReplyItems,
      buildTemplateMessageFromPayload,
      chunkMarkdownText,
      resolveLineAccount,
      resolveTextChunkLimit,
    },
  };
}
