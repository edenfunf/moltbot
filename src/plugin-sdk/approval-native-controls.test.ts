import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createNativeApprovalControlRegistry } from "./approval-runtime.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("native approval controls", () => {
  it.each([
    { releaseClaimOnLookupExpiry: false, expiry: "lookup", next: "in-flight" },
    { releaseClaimOnLookupExpiry: true, expiry: "lookup", next: "settled" },
    { releaseClaimOnLookupExpiry: false, expiry: "sweep", next: "settled" },
  ] as const)(
    "preserves claim cleanup for $expiry with releaseClaimOnLookupExpiry=$releaseClaimOnLookupExpiry",
    async ({ releaseClaimOnLookupExpiry, expiry, next }) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const controls = createNativeApprovalControlRegistry({ releaseClaimOnLookupExpiry });
      const finish = createDeferred();
      controls.register({ token: "rebound", expiresAtMs: 2_000 });
      const pending = controls.settle("rebound", () => finish.promise);
      try {
        vi.setSystemTime(2_000);
        if (expiry === "sweep") {
          controls.pruneExpired(2_000);
        } else {
          expect(controls.get("rebound")).toBeNull();
        }
        controls.register({ token: "rebound", expiresAtMs: 3_000 });
        const result = await controls.settle("rebound", async () => "replacement");
        expect(result.kind).toBe(next);
      } finally {
        finish.resolve();
        await pending;
      }
    },
  );

  it("keeps plugin registries independent even when tokens coincide", async () => {
    type Binding = { token: string; expiresAtMs: number; approvalId: string };
    const first = createNativeApprovalControlRegistry<Binding>({
      releaseClaimOnLookupExpiry: true,
    });
    const second = createNativeApprovalControlRegistry<Binding>({
      releaseClaimOnLookupExpiry: false,
    });
    const binding = { token: "same-token", expiresAtMs: Date.now() + 60_000 };
    first.register({ ...binding, approvalId: "first" });
    second.register({ ...binding, approvalId: "second" });

    await expect(
      first.settle(binding.token, async (entry) => entry.approvalId),
    ).resolves.toMatchObject({
      kind: "settled",
      result: "first",
    });
    expect(second.get(binding.token)?.approvalId).toBe("second");
    await expect(
      second.settle(binding.token, async (entry) => entry.approvalId),
    ).resolves.toMatchObject({
      kind: "settled",
      result: "second",
    });
  });
  // A refusal is not a missing approval: it answers who may decide, so the control survives
  // it, while a missing approval retires the control.
  it.each([
    ["FORBIDDEN", "APPROVAL_AUTHORITY_REQUIRED", "not-authorized", true],
    ["INVALID_REQUEST", "APPROVAL_NOT_FOUND", "not-found", false],
  ] as const)(
    "a %s/%s resolve settles as %s and keeps the control: %s",
    async (gatewayCode, reason, kind, retained) => {
      type Binding = { token: string; expiresAtMs: number; approvalId: string };
      const registry = createNativeApprovalControlRegistry<Binding>({
        releaseClaimOnLookupExpiry: false,
      });
      const binding = { token: "tok", expiresAtMs: Date.now() + 60_000, approvalId: "a1" };
      registry.register(binding);
      const failure = Object.assign(new Error("refused"), {
        gatewayCode,
        details: gatewayCode === "FORBIDDEN" ? { code: reason } : { reason },
      });
      await expect(
        registry.settle(binding.token, async () => {
          throw failure;
        }),
      ).resolves.toMatchObject({ kind });
      expect(Boolean(registry.get(binding.token))).toBe(retained);
      // The listed approver's next tap on the same control must be able to decide it.
      await expect(registry.settle(binding.token, async () => "decided")).resolves.toMatchObject({
        kind: retained ? "settled" : "missing",
      });
    },
  );
});
