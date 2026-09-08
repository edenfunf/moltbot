// Line plugin module implements monitor durable behavior.
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import type { LineChannelData } from "./types.js";

type LineDurableReplyOptions = {
  to: string;
  replyToId: null;
};

function hasLineChannelData(payload: ReplyPayload): boolean {
  const lineData = payload.channelData?.line as LineChannelData | undefined;
  return Boolean(lineData && Object.keys(lineData).length > 0);
}

export function resolveLineDurableReplyOptions(params: {
  payload: ReplyPayload;
  infoKind: string;
  to: string;
  replyToken?: string | null;
  replyTokenUsed: boolean;
}): LineDurableReplyOptions | false {
  if (params.infoKind !== "final") {
    return false;
  }
  if (params.replyToken && !params.replyTokenUsed) {
    return false;
  }
  // Widening which replies take the durable path is a separate contract change
  // from resolving one that was interrupted, so rich and media replies keep the
  // inline path this fix does not touch.
  if (hasLineChannelData(params.payload)) {
    return false;
  }
  const reply = resolveSendableOutboundReplyParts(params.payload);
  if (reply.hasMedia || !reply.hasText) {
    return false;
  }
  // An explicit reply-to survives the inbound context's threading policy. LINE cannot
  // honour it, and core would require a `replyTo` capability this channel does not
  // declare, so such a reply keeps the inline path rather than being refused there.
  if (params.payload.replyToId != null) {
    return false;
  }
  return {
    to: params.to,
    // LINE cannot quote a message id, so this send replies to nothing. Core would
    // otherwise take the reply-to from the turn context (`ReplyToIdFull`), which
    // LINE leaves unset today but #134220 fills in from an inbound quote — and that
    // would require a `replyTo` capability this send does not use and cannot honour.
    replyToId: null,
  };
}
