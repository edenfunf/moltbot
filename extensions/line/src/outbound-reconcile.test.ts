// Line tests cover durable unknown-send reconciliation behavior.
import type { ChannelMessageUnknownSendContext } from "openclaw/plugin-sdk/channel-outbound";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime } from "../api.js";
import { linePlugin } from "./channel.js";
import {
  createLineBlobStoreState,
  type LineBlobStoreFake,
} from "./outbound-harness.test-support.js";
import { setLineRuntime } from "./runtime.js";
import { LINE_RETRY_KEY_TTL_MS, resolveLinePushRetryKey } from "./send-retry.js";

const NOW = 1_800_000_000_000;
const QUEUE_ID = "queue-entry-1";
const TARGET = "line:user:U0123456789abcdef0123456789abcdef";
const CFG = {
  channels: { line: { channelAccessToken: "test-token-placeholder" } },
} as OpenClawConfig;

let blobs: LineBlobStoreFake;
const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Drives the real push path so the recorded plan is written by production code
 * rather than by a stand-in that could forget to record anything.
 */
async function sendDurablePart(params: { partIndex: number; partCount: number; text: string }) {
  await linePlugin.outbound?.sendPayload?.({
    cfg: CFG,
    to: TARGET,
    text: params.text,
    payload: { text: params.text },
    deliveryQueueId: QUEUE_ID,
    deliveryPartIndex: params.partIndex,
    deliveryPartCount: params.partCount,
  });
}

/** A flex payload fans one part out into two pushes: the card, then the text. */
async function sendDurableFlexPart() {
  await linePlugin.outbound?.sendPayload?.({
    cfg: CFG,
    to: TARGET,
    text: "hello",
    payload: {
      text: "hello",
      channelData: { line: { flexMessage: { altText: "alt", contents: { type: "bubble" } } } },
    },
    deliveryQueueId: QUEUE_ID,
    deliveryPartIndex: 0,
    deliveryPartCount: 1,
  });
}

function pushedRequests(): { retryKey: string | null; messages: unknown }[] {
  return fetchMock.mock.calls.map(([, init]) => {
    const body = typeof init?.body === "string" ? init.body : "{}";
    return {
      retryKey: new Headers(init?.headers).get("X-Line-Retry-Key"),
      messages: (JSON.parse(body) as { messages?: unknown }).messages,
    };
  });
}

function planKeys(): string[] {
  return Array.from(blobs.keys()).toSorted();
}

/** Stored plan shape the tests reshape to stand in for an interrupted run. */
type StoredPlan = Record<string, unknown> & {
  payload: Record<string, unknown>;
  pushes: { retryKey: string; messages: unknown[] }[];
};

function readPlan(key: string): StoredPlan {
  return JSON.parse(new TextDecoder().decode(blobs.get(key)!)) as StoredPlan;
}

function writePlan(key: string, plan: StoredPlan): void {
  blobs.set(key, new TextEncoder().encode(JSON.stringify(plan)));
}

function reconcile(overrides: Partial<ChannelMessageUnknownSendContext> = {}) {
  const ctx: ChannelMessageUnknownSendContext = {
    cfg: CFG,
    queueId: QUEUE_ID,
    channel: "line",
    to: TARGET,
    enqueuedAt: NOW,
    platformSendStartedAt: NOW,
    retryCount: 1,
    payloads: [{ text: "hello" }],
    ...overrides,
  };
  return linePlugin.message?.durableFinal?.reconcileUnknownSend?.(ctx);
}

describe("LINE unknown-send reconciliation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    fetchMock.mockReset();
    // A Response body can only be read once, so every call builds a fresh one.
    fetchMock.mockImplementation(async () =>
      jsonResponse({ sentMessages: [{ id: "delivered-1" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const store = createLineBlobStoreState();
    blobs = store.blobs;
    // The real send path owns the recording, so the runtime keeps only the
    // chunker and the durable store the production code reaches for.
    setLineRuntime({
      state: store.state,
      channel: {
        text: {
          chunkMarkdownText: (text: string) => [text],
          resolveTextChunkLimit: () => 5000,
        },
      },
    } as unknown as PluginRuntime);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reissues every recorded push under the key LINE deduplicated it by", async () => {
    await sendDurablePart({ partIndex: 0, partCount: 2, text: "first" });
    await sendDurablePart({ partIndex: 1, partCount: 2, text: "second" });
    const live = pushedRequests();
    fetchMock.mockClear();

    await expect(reconcile()).resolves.toMatchObject({ status: "sent" });

    // The replay reissues the live requests verbatim: same order, same keys,
    // same bodies. That is what makes LINE answer 409 instead of delivering again.
    expect(pushedRequests()).toEqual(live);
    expect(live.map((request) => request.retryKey)).toEqual([
      resolveLinePushRetryKey({ deliveryQueueId: QUEUE_ID, partIndex: 0, pushIndex: 0 }),
      resolveLinePushRetryKey({ deliveryQueueId: QUEUE_ID, partIndex: 1, pushIndex: 0 }),
    ]);
    expect(live.map((request) => request.messages)).toEqual([
      [{ type: "text", text: "first" }],
      [{ type: "text", text: "second" }],
    ]);
  });

  it("returns the identity of every replayed push, not just the last of each part", async () => {
    await sendDurableFlexPart();
    fetchMock.mockClear();
    let replayed = 0;
    fetchMock.mockImplementation(async () => {
      replayed += 1;
      return jsonResponse({ sentMessages: [{ id: `replayed-${replayed}` }] });
    });

    const reconciliation = await reconcile();

    // Both physical sends of the fan-out settle the queue entry; dropping one
    // would lose delivery identity for part of a recovered reply.
    expect(replayed).toBe(2);
    expect(reconciliation).toMatchObject({ status: "sent" });
    expect(
      (reconciliation as { receipt: { platformMessageIds: string[] } }).receipt.platformMessageIds,
    ).toEqual(["replayed-1", "replayed-2"]);
  });

  it.each([
    [
      "a card, media and text",
      {
        text: "caption",
        mediaUrl: "https://example.com/image.png",
        channelData: { line: { flexMessage: { altText: "alt", contents: { type: "bubble" } } } },
      },
    ],
    [
      "a batch carrying quick replies",
      {
        text: "",
        channelData: {
          line: {
            quickReplies: ["One", "Two"],
            flexMessage: { altText: "alt", contents: { type: "bubble" } },
          },
        },
      },
    ],
    [
      "markdown that renders as its own segments",
      { text: "| Name | Status |\n|---|---|\n| OpenClaw | ready |\n\nAfter the table." },
    ],
  ])("keys every platform send %s fans out into", async (_name, payload) => {
    await linePlugin.outbound?.sendPayload?.({
      cfg: CFG,
      to: TARGET,
      text: (payload as { text: string }).text,
      payload,
      deliveryQueueId: QUEUE_ID,
      deliveryPartIndex: 0,
      deliveryPartCount: 1,
    });

    // A media or card push is replayed under the same key a text push is, and the
    // adapter declares it reconciles those kinds; a push that skipped the recorder
    // would be replayed under a fresh key LINE cannot deduplicate.
    const keys = pushedRequests().map((request) => request.retryKey);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys).toEqual(
      keys.map((_, pushIndex) =>
        resolveLinePushRetryKey({ deliveryQueueId: QUEUE_ID, partIndex: 0, pushIndex }),
      ),
    );
  });

  it("refuses a delivery that carried no durable record instead of replaying it", async () => {
    // A recorded push lands before the marker that routes a delivery here, so an
    // empty record means core withheld the queue id and those pushes went out
    // under keys LINE will not deduplicate. Replaying is a second copy.
    await expect(reconcile()).resolves.toMatchObject({
      status: "unresolved",
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("finishes a part that was interrupted between its pushes", async () => {
    await sendDurableFlexPart();
    const live = pushedRequests();
    expect(live).toHaveLength(2);

    // A crash between the two pushes leaves only the first one recorded.
    const [key] = planKeys();
    const plan = readPlan(key!);
    writePlan(key!, { ...plan, pushes: plan.pushes.slice(0, 1) });
    fetchMock.mockClear();

    await expect(reconcile()).resolves.toMatchObject({ status: "sent" });

    // The recorded push is reissued under its key so LINE drops it as a duplicate,
    // and the push the crash cut off is delivered for the first time.
    expect(pushedRequests()).toEqual(live);
  });

  it("keeps the whole recorded fan-out after a replay that is itself interrupted", async () => {
    // Two pushes in one part: the flex card, then the text.
    await sendDurableFlexPart();
    const [key] = planKeys();
    expect(readPlan(key!).pushes).toHaveLength(2);

    // A replay that dies on its very first reissued push must not leave the
    // record shorter than it found it: the pushes it never reached would then
    // have nothing left to be compared against on the next recovery.
    fetchMock.mockClear();
    fetchMock.mockImplementation(async () => {
      throw new Error("recovery process died mid-replay");
    });
    await expect(reconcile()).resolves.toMatchObject({ status: "unresolved" });

    expect(readPlan(key!).pushes).toHaveLength(2);
  });

  it("refuses to settle a replay that reproduced fewer pushes than were recorded", async () => {
    await sendDurableFlexPart();
    const [key] = planKeys();
    expect(readPlan(key!).pushes).toHaveLength(2);

    // The fan-out is rebuilt from live configuration, so a limit change between
    // the crash and the recovery can render a shorter one. Standing in for that:
    // the payload now renders only the first of the two recorded pushes.
    const plan = readPlan(key!);
    writePlan(key!, { ...plan, payload: { channelData: plan.payload.channelData } });
    fetchMock.mockClear();

    await expect(reconcile()).resolves.toMatchObject({ status: "unresolved", retryable: false });
  });

  it("refuses to replay a fan-out that no longer reproduces what was sent", async () => {
    await sendDurablePart({ partIndex: 0, partCount: 1, text: "hello" });
    const [key] = planKeys();
    const plan = readPlan(key!);
    // Stand in for anything that could make the fan-out diverge from the record.
    writePlan(key!, {
      ...plan,
      pushes: [{ ...plan.pushes[0]!, messages: [{ type: "text", text: "something else" }] }],
    });
    fetchMock.mockClear();

    await expect(reconcile()).resolves.toMatchObject({ status: "unresolved", retryable: false });
    // Reissuing a diverged push would hide its content behind a stale 409.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to replay when a planned part was never dispatched", async () => {
    await sendDurablePart({ partIndex: 0, partCount: 2, text: "first" });
    fetchMock.mockClear();

    await expect(reconcile()).resolves.toMatchObject({ status: "unresolved", retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The plan is written just before the dispatch marker the window is measured
  // from, so a plan expiring on the bare retry-key TTL is already gone for the
  // last stretch of the window it exists to serve. Reconciliation reads a missing
  // plan as "this delivery carried no recorder" and retires a reply LINE would
  // still have deduplicated.
  // The queue entry's timestamp is refreshed on every dispatch, so it cannot say when
  // LINE first saw these keys. The plan records that instant, and it is what decides
  // the window: a delivery whose keys are a day old must be refused even though the
  // entry says the latest attempt started seconds ago.
  it("measures the window from the recorded dispatch, not the refreshed queue entry", async () => {
    await sendDurableFlexPart();
    fetchMock.mockClear();
    vi.setSystemTime(NOW + LINE_RETRY_KEY_TTL_MS + 1);

    const result = await reconcile({ platformSendStartedAt: NOW + LINE_RETRY_KEY_TTL_MS });

    expect(result).toEqual({
      status: "unresolved",
      error: "LINE retry key expired before the queued send could be reconciled",
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Entering the window is not enough: the retry backoff between attempts can outlast
  // it. Once LINE has stopped deduplicating the key, another attempt is a second
  // delivery, so the replay has to stop mid-backoff rather than finish its retries.
  it("stops a replay whose backoff outlives the retry-key window", async () => {
    vi.useFakeTimers();
    await sendDurablePart({ partIndex: 0, partCount: 1, text: "hello" });
    fetchMock.mockClear();
    // The first attempt fails retryably and moves the clock past the deadline, so the
    // runner backs off into a window LINE no longer deduplicates.
    fetchMock.mockImplementationOnce(async () => {
      vi.setSystemTime(NOW + LINE_RETRY_KEY_TTL_MS);
      return jsonResponse({ message: "upstream" }, 503);
    });

    const reconciling = reconcile({ platformSendStartedAt: NOW });
    await vi.runAllTimersAsync();
    const result = await reconciling;

    expect(result).toMatchObject({ status: "unresolved", retryable: false });
    // Exactly the one attempt that was still inside the window.
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  // The plan store refuses a new entry once its namespace is full rather than evicting
  // one, and that refusal reaches the operator unchanged: it names neither LINE nor the
  // part, which is what the troubleshooting docs have to say.
  it("surfaces a full plan namespace as the store's own refusal", async () => {
    const store = createLineBlobStoreState();
    setLineRuntime({
      state: {
        openBlobStore: (options: { namespace: string }) =>
          store.state.openBlobStore({
            ...options,
            maxEntries: 0,
            overflowPolicy: "reject-new",
          }),
      },
      channel: {
        text: { chunkMarkdownText: (text: string) => [text], resolveTextChunkLimit: () => 5000 },
      },
    } as unknown as PluginRuntime);

    await expect(sendDurableFlexPart()).rejects.toThrow(
      "Plugin blob namespace reached its stored row limit.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The one user-visible harm the troubleshooting docs describe: recording happens push
  // by push, so a ceiling reached partway leaves the earlier pushes already delivered
  // and only the rest withheld. A part is rewritten under one key, so the row count
  // cannot grow within it — only the per-entry byte ceiling can stop a later push.
  it("leaves the earlier pushes delivered when a later one cannot be recorded", async () => {
    const store = createLineBlobStoreState();
    let ceiling: number | undefined;
    const writes: number[] = [];
    const chunked = (text: string) => text.match(/.{1,40}/gs) ?? [text];
    setLineRuntime({
      state: {
        openBlobStore: (options: { namespace: string }) => {
          const opened = store.state.openBlobStore({ ...options, maxBytesPerEntry: ceiling });
          return {
            ...opened,
            register: async (key: string, bytes: Uint8Array, ...rest: unknown[]) => {
              writes.push(bytes.byteLength);
              return await (opened.register as (...args: unknown[]) => Promise<void>)(
                key,
                bytes,
                ...rest,
              );
            },
          };
        },
      },
      channel: {
        text: { chunkMarkdownText: chunked, resolveTextChunkLimit: () => 40 },
      },
    } as unknown as PluginRuntime);
    const threeChunks = "x".repeat(120);

    // Observe how the record grows push by push, then cap between the first and second
    // so the first push records and the second is the one refused.
    await sendDurablePart({ partIndex: 0, partCount: 1, text: threeChunks });
    expect(writes.length).toBeGreaterThan(1);
    ceiling = writes[0];
    store.blobs.clear();
    writes.length = 0;
    fetchMock.mockClear();

    await expect(
      sendDurablePart({ partIndex: 0, partCount: 1, text: threeChunks }),
    ).rejects.toThrow("byte limit");

    // The first chunk reached the recipient; the rest of the reply did not.
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("refuses to replay once LINE has forgotten the retry keys", async () => {
    await sendDurablePart({ partIndex: 0, partCount: 1, text: "hello" });
    fetchMock.mockClear();

    await expect(
      reconcile({ platformSendStartedAt: NOW - LINE_RETRY_KEY_TTL_MS }),
    ).resolves.toEqual({
      status: "unresolved",
      error: "LINE retry key expired before the queued send could be reconciled",
      retryable: false,
    });
    // Replaying an expired key would deliver a second copy, so nothing is sent.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a deterministic rejection of the first push as never sent", async () => {
    await sendDurablePart({ partIndex: 0, partCount: 1, text: "hello" });
    fetchMock.mockImplementation(async () => jsonResponse({ message: "invalid recipient" }, 400));

    await expect(reconcile()).resolves.toEqual({ status: "not_sent" });
  });

  it("keeps a rejection after an accepted push unresolved instead of claiming nothing landed", async () => {
    await sendDurablePart({ partIndex: 0, partCount: 2, text: "first" });
    await sendDurablePart({ partIndex: 1, partCount: 2, text: "second" });
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ sentMessages: [{ id: "delivered-1" }] }))
      .mockImplementation(async () => jsonResponse({ message: "invalid recipient" }, 400));

    // The first part is delivered, so "never sent" would license a full replay.
    await expect(reconcile()).resolves.toMatchObject({ status: "unresolved", retryable: false });
  });

  it("leaves a transient failure unresolved and retryable", async () => {
    await sendDurablePart({ partIndex: 0, partCount: 1, text: "hello" });
    fetchMock.mockImplementation(async () => jsonResponse({ message: "boom" }, 500));

    const reconciled = reconcile();
    await vi.runAllTimersAsync();

    await expect(reconciled).resolves.toMatchObject({ status: "unresolved", retryable: true });
  });

  it("drops recorded content once the delivery is settled", async () => {
    await sendDurablePart({ partIndex: 0, partCount: 1, text: "hello" });
    expect(planKeys()).toHaveLength(1);

    await linePlugin.message?.durableFinal?.afterUnknownSendTerminal?.({
      cfg: CFG,
      queueId: QUEUE_ID,
      channel: "line",
      to: TARGET,
      enqueuedAt: NOW,
      retryCount: 1,
      payloads: [{ text: "hello" }],
    });

    expect(planKeys()).toHaveLength(0);
  });
});

describe("durable retry keys", () => {
  it("derives the same key for one durable push in every process", () => {
    const key = resolveLinePushRetryKey({ deliveryQueueId: QUEUE_ID, partIndex: 0, pushIndex: 0 });

    expect(resolveLinePushRetryKey({ deliveryQueueId: QUEUE_ID, partIndex: 0, pushIndex: 0 })).toBe(
      key,
    );
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("keys each part and each push inside a part separately", () => {
    const first = resolveLinePushRetryKey({ deliveryQueueId: "q", partIndex: 0, pushIndex: 0 });

    expect(resolveLinePushRetryKey({ deliveryQueueId: "q", partIndex: 1, pushIndex: 0 })).not.toBe(
      first,
    );
    expect(resolveLinePushRetryKey({ deliveryQueueId: "q", partIndex: 0, pushIndex: 1 })).not.toBe(
      first,
    );
  });

  it("keeps unqueued sends on fresh keys", () => {
    expect(resolveLinePushRetryKey({})).not.toBe(resolveLinePushRetryKey({}));
  });
});
