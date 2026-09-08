import type { messagingApi } from "@line/bot-sdk";
import {
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
// Line plugin module implements outbound behavior.
import {
  defineChannelMessageAdapter,
  listMessageReceiptPlatformIds,
  type ChannelMessageSendResult,
  type MessageReceiptPartKind,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  createAttachedChannelResultAdapter,
  createEmptyChannelResult,
} from "openclaw/plugin-sdk/channel-send-result";
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { resolveOutboundMediaUrls } from "openclaw/plugin-sdk/reply-payload";
import { sanitizeAssistantVisibleText } from "openclaw/plugin-sdk/text-chunking";
import { buildLineMediaMessage } from "./outbound-media.js";
import { buildLineQuickReplyFallbackText } from "./quick-reply-fallback.js";
import {
  createLineQuickReply,
  LINE_PRESENTATION_CAPABILITIES,
  renderLineCard,
  renderLinePresentation,
} from "./rich-messages.js";
import { getLineRuntime } from "./runtime.js";
import { createLineSendReceipt } from "./send-receipt.js";
import { explainLineRefusal } from "./send-retry.js";
import type { LineChannelData, LineSendResult, ResolvedLineAccount } from "./types.js";

const loadLineOutboundRuntime = createLazyRuntimeModule(() => import("./outbound.runtime.js"));

export const lineOutboundAdapter: NonNullable<ChannelPlugin<ResolvedLineAccount>["outbound"]> = {
  deliveryMode: "direct",
  chunker: (text, limit) => getLineRuntime().channel.text.chunkMarkdownText(text, limit),
  textChunkLimit: 5000,
  sanitizeText: ({ text }) => sanitizeAssistantVisibleText(text),
  presentationCapabilities: LINE_PRESENTATION_CAPABILITIES,
  renderPresentation: ({ payload, presentation }) => renderLinePresentation(payload, presentation),
  sendPayload: async ({ to, payload, accountId, cfg, onDeliveryResult }) => {
    const runtime = getLineRuntime();
    const outboundRuntime = await loadLineOutboundRuntime();
    const rawLineData = (payload.channelData?.line as LineChannelData | undefined) ?? {};
    const lineData =
      rawLineData.card && !rawLineData.flexMessage
        ? { ...rawLineData, flexMessage: renderLineCard(rawLineData.card) }
        : rawLineData;
    const lineRuntime = runtime.channel.line;
    const location = lineData.location;
    const locationMessage = location ? outboundRuntime.createLocationMessage(location) : null;
    const sendBatch = lineRuntime?.pushMessagesLine ?? outboundRuntime.pushMessagesLine;
    const buildTemplate =
      lineRuntime?.buildTemplateMessageFromPayload ??
      outboundRuntime.buildTemplateMessageFromPayload;
    const sendOptions = { verbose: false, cfg, accountId: accountId ?? undefined };

    let lastResult: LineSendResult | null = null;
    const recordResult = async (
      resultPromise: Promise<LineSendResult>,
    ): Promise<LineSendResult> => {
      let result: LineSendResult;
      try {
        result = await resultPromise;
      } catch (error) {
        // Accepted payload parts keep their receipt and must not wait for quota diagnosis.
        const refusal =
          lastResult !== null || isChannelPartialDeliveryError(error)
            ? undefined
            : await explainLineRefusal({ error, cfg, accountId });
        throw refusal?.retryable !== undefined
          ? new PlatformMessageNotDispatchedError(refusal.reason, {
              cause: error,
              retryable: refusal.retryable,
            })
          : error;
      }
      lastResult = result;
      try {
        await onDeliveryResult?.(createEmptyChannelResult("line", { ...result }));
      } catch (error) {
        // Observers run after provider acceptance; losing this receipt invites duplicate delivery.
        throw createChannelPartialDeliveryError(error, {
          messageIds: listMessageReceiptPlatformIds(result.receipt),
          receipt: result.receipt,
          visibleReplySent: true,
        });
      }
      return result;
    };
    const quickReplies = lineData.quickReplies ?? [];
    const quickReplyItems = lineData.quickReplyItems ?? [];
    const hasQuickReplies = quickReplies.length > 0 || quickReplyItems.length > 0;
    const quickReply = quickReplyItems.length
      ? createLineQuickReply(quickReplyItems)
      : quickReplies.length
        ? (lineRuntime?.createQuickReplyItems ?? outboundRuntime.createQuickReplyItems)(
            quickReplies,
          )
        : undefined;
    const quickReplyLabels = quickReplyItems.length
      ? quickReplyItems.map((item) => item.label)
      : quickReplies;

    // LINE charges one monthly message per request per recipient, whatever the
    // request carries, so a payload's parts travel together up to the batch cap.
    const sendMessageBatch = async (messages: messagingApi.Message[]) => {
      for (let i = 0; i < messages.length; i += 5) {
        await recordResult(sendBatch(to, messages.slice(i, i + 5), sendOptions));
      }
    };

    const processed = payload.text
      ? outboundRuntime.processLineMessage(payload.text)
      : { text: "", flexMessages: [] };

    const chunkLimit =
      runtime.channel.text.resolveTextChunkLimit?.(cfg, "line", accountId ?? undefined, {
        fallbackLimit: 5000,
      }) ?? 5000;
    const chunkTextMessages = (text: string): messagingApi.TextMessage[] =>
      runtime.channel.text
        .chunkMarkdownText(text, chunkLimit)
        .map((chunk) => ({ type: "text" as const, text: chunk }));

    const orderedMessages = processed.segments?.flatMap<
      messagingApi.FlexMessage | messagingApi.TextMessage
    >((segment) => (segment.type === "flex" ? [segment.message] : chunkTextMessages(segment.text)));
    const bodyMessages: messagingApi.Message[] =
      orderedMessages ?? (processed.text ? chunkTextMessages(processed.text) : []);

    const richMessages: messagingApi.Message[] = [];
    if (lineData.flexMessage) {
      richMessages.push(
        outboundRuntime.createFlexMessage(
          lineData.flexMessage.altText,
          lineData.flexMessage.contents as Parameters<typeof outboundRuntime.createFlexMessage>[1],
        ),
      );
    }
    if (lineData.templateMessage) {
      const template = buildTemplate(lineData.templateMessage);
      if (template) {
        richMessages.push(template);
      }
    }
    if (locationMessage) {
      richMessages.push(locationMessage);
    }
    if (!orderedMessages) {
      for (const flexMsg of processed.flexMessages) {
        richMessages.push(outboundRuntime.createFlexMessage(flexMsg.altText, flexMsg.contents));
      }
    }

    const mediaOptions = {
      mediaKind: lineData.mediaKind,
      previewImageUrl: lineData.previewImageUrl,
      durationMs: lineData.durationMs,
      trackingId: lineData.trackingId,
    };
    const mediaMessages: messagingApi.Message[] = [];
    let deliveryError: unknown;
    for (const rawUrl of resolveOutboundMediaUrls(payload)) {
      const url = rawUrl?.trim();
      if (!url) {
        continue;
      }
      try {
        mediaMessages.push(await buildLineMediaMessage(url, mediaOptions, to));
      } catch (error) {
        // Media LINE will not carry must not take the text that came with it.
        deliveryError ??= error;
      }
    }

    // Quick replies disappear as soon as a newer message arrives, so whatever
    // must stay last carries them: media leads when the payload ends in text.
    const endsInText = hasQuickReplies && bodyMessages.some((message) => message.type === "text");
    const messages: messagingApi.Message[] = endsInText
      ? [...richMessages, ...mediaMessages, ...bodyMessages]
      : [...richMessages, ...bodyMessages, ...mediaMessages];
    if (hasQuickReplies && messages.length === 0 && deliveryError === undefined) {
      // The fallback carries quick replies for a payload that had nothing else;
      // one whose only content failed to build surfaces that failure instead.
      messages.push({ type: "text", text: buildLineQuickReplyFallbackText(quickReplyLabels) });
    }
    const lastMessage = messages.at(-1);
    if (quickReply && lastMessage) {
      messages[messages.length - 1] = { ...lastMessage, quickReply };
    }

    await sendMessageBatch(messages);
    if (deliveryError !== undefined) {
      throw deliveryError;
    }
    const completedResult = lastResult as LineSendResult | null;
    if (!completedResult) {
      throw new Error("Message must be non-empty for LINE sends");
    }
    return createEmptyChannelResult("line", { ...completedResult });
  },
  ...createAttachedChannelResultAdapter({
    channel: "line",
    // The payload owner records each physical send before the next fallible step;
    // bypassing it fabricates Flex-only ids and loses partial-delivery evidence.
    sendText: async (ctx) =>
      await lineOutboundAdapter.sendPayload!({
        ...ctx,
        payload: { text: ctx.text },
      }),
    sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) =>
      await (
        await loadLineOutboundRuntime()
      ).sendMessageLine(to, text, {
        verbose: false,
        mediaUrl,
        cfg,
        accountId: accountId ?? undefined,
      }),
  }),
};

function toLineMessageSendResult(
  result: Awaited<ReturnType<NonNullable<typeof lineOutboundAdapter.sendPayload>>>,
  kind: MessageReceiptPartKind,
): ChannelMessageSendResult {
  const source = result as typeof result & { chatId?: string };
  const receipt =
    result.receipt ??
    (result.messageId
      ? createLineSendReceipt({
          messageId: result.messageId,
          chatId: source.chatId ?? "",
          kind,
        })
      : undefined);
  if (!receipt) {
    throw new Error("LINE message adapter send did not return a receipt");
  }
  return {
    messageId: result.messageId || receipt.primaryPlatformMessageId,
    receipt,
  };
}

export const lineMessageAdapter = defineChannelMessageAdapter({
  id: "line",
  durableFinal: {
    capabilities: {
      text: true,
      media: true,
      messageSendingHooks: true,
    },
  },
  send: {
    text: async ({ cfg, to, text, accountId, onDeliveryResult }) => {
      const result = await lineOutboundAdapter.sendPayload!({
        cfg,
        to,
        text,
        accountId,
        payload: { text },
        onDeliveryResult: async (deliveryResult) => {
          await onDeliveryResult?.(toLineMessageSendResult(deliveryResult, "text"));
        },
      });
      return toLineMessageSendResult(result, "text");
    },
    media: async ({ cfg, to, text, mediaUrl, accountId, onDeliveryResult }) => {
      const result = await lineOutboundAdapter.sendPayload!({
        cfg,
        to,
        text,
        mediaUrl,
        accountId,
        payload: { text, mediaUrl },
        onDeliveryResult: async (deliveryResult) => {
          await onDeliveryResult?.(toLineMessageSendResult(deliveryResult, "media"));
        },
      });
      return toLineMessageSendResult(result, "media");
    },
  },
  receive: {
    defaultAckPolicy: "after_receive_record",
    supportedAckPolicies: ["after_receive_record"],
  },
});
