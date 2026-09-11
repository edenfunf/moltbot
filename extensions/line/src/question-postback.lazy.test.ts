import { expect, it, vi } from "vitest";

const gateway = vi.hoisted(() => ({
  loaded: vi.fn(),
  resolveOption: vi.fn(async () => ({ status: "answered" as const })),
}));

vi.mock("openclaw/plugin-sdk/question-gateway-runtime", () => {
  gateway.loaded();
  return { questionGatewayRuntime: { resolveOption: gateway.resolveOption } };
});

it("loads the question Gateway only when resolving a tap", async () => {
  const { buildLineQuestionPostbackData, parseLineQuestionPostbackData, resolveLineQuestionPostback } =
    await import("./question-postback.js");
  const callback = { questionId: "ask_0123456789abcdef0123456789abcdef", optionIndex: 1 };
  const data = buildLineQuestionPostbackData(callback);
  expect(parseLineQuestionPostbackData(data ?? "")).toEqual(callback);
  expect(gateway.loaded).not.toHaveBeenCalled();

  const cfg = {};
  await expect(
    resolveLineQuestionPostback({ cfg, callback, senderId: "user-one", accountId: "default" }),
  ).resolves.toEqual({ status: "answered" });
  expect(gateway.loaded).toHaveBeenCalledTimes(1);
  expect(gateway.resolveOption).toHaveBeenCalledWith({
    cfg,
    questionId: callback.questionId,
    optionIndex: callback.optionIndex,
    senderId: "user-one",
    clientDisplayName: "LINE question (default)",
  });
});
