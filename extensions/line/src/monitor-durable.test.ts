// Line tests cover monitor durable plugin behavior.
import { describe, expect, it } from "vitest";
import { resolveLineDurableReplyOptions } from "./monitor-durable.js";

describe("resolveLineDurableReplyOptions", () => {
  it("enables durable final delivery for push-only text replies", () => {
    expect(
      resolveLineDurableReplyOptions({
        payload: { text: "hello" },
        infoKind: "final",
        to: "U123",
        replyToken: "reply-token",
        replyTokenUsed: true,
      }),
      // No requiredCapabilities: core derives them from this payload and the explicit
      // null reply-to, and nothing here would answer differently. Naming them again
      // would mirror that derivation from fewer inputs.
    ).toEqual({
      to: "U123",
      replyToId: null,
    });
  });

  it("keeps unused reply-token delivery on the legacy path", () => {
    expect(
      resolveLineDurableReplyOptions({
        payload: { text: "hello" },
        infoKind: "final",
        to: "U123",
        replyToken: "reply-token",
        replyTokenUsed: false,
      }),
    ).toBe(false);
  });

  it("keeps a reply that carries an explicit reply-to on the legacy path", () => {
    // LINE cannot quote by message id, so core would require a `replyTo` capability
    // this channel does not declare and refuse the durable send outright.
    expect(
      resolveLineDurableReplyOptions({
        payload: { text: "hello", replyToId: "630776817589944423" },
        infoKind: "final",
        to: "U123",
        replyTokenUsed: true,
      }),
    ).toBe(false);
  });

  it("keeps rich and media replies on the legacy path", () => {
    expect(
      resolveLineDurableReplyOptions({
        payload: { text: "hello", channelData: { line: { quickReplies: ["One"] } } },
        infoKind: "final",
        to: "U123",
        replyTokenUsed: true,
      }),
    ).toBe(false);
    expect(
      resolveLineDurableReplyOptions({
        payload: { text: "photo", mediaUrl: "https://example.com/image.png" },
        infoKind: "final",
        to: "U123",
        replyTokenUsed: true,
      }),
    ).toBe(false);
  });

  it("keeps non-final and empty replies on the legacy path", () => {
    expect(
      resolveLineDurableReplyOptions({
        payload: { text: "hello" },
        infoKind: "block",
        to: "U123",
        replyTokenUsed: true,
      }),
    ).toBe(false);
    expect(
      resolveLineDurableReplyOptions({
        payload: { text: "" },
        infoKind: "final",
        to: "U123",
        replyTokenUsed: true,
      }),
    ).toBe(false);
  });
});
