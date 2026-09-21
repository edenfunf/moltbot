// Covers approval-not-found error detection.
import { describe, expect, it } from "vitest";
import {
  isApprovalAuthorityError,
  isApprovalKindMismatchError,
  isApprovalNotFoundError,
  isApprovalStaleError,
} from "./approval-errors.js";

describe("isApprovalNotFoundError", () => {
  it("matches direct approval-not-found gateway codes", () => {
    const err = Object.assign(new Error("approval not found"), {
      gatewayCode: "APPROVAL_NOT_FOUND",
    });
    expect(isApprovalNotFoundError(err)).toBe(true);
  });

  it("matches structured invalid-request approval-not-found details", () => {
    const err = Object.assign(new Error("approval not found"), {
      gatewayCode: "INVALID_REQUEST",
      details: { reason: "APPROVAL_NOT_FOUND" },
    });
    expect(isApprovalNotFoundError(err)).toBe(true);
  });

  it("matches legacy message-only not-found errors", () => {
    expect(isApprovalNotFoundError(new Error("unknown or expired approval id"))).toBe(true);
    expect(isApprovalNotFoundError(new Error("approval expired or not found"))).toBe(true);
  });

  it("ignores unrelated errors", () => {
    expect(isApprovalNotFoundError(new Error("network timeout"))).toBe(false);
    expect(isApprovalNotFoundError("unknown or expired approval id")).toBe(false);
  });
});

describe("isApprovalStaleError", () => {
  it("matches structured already-resolved gateway errors", () => {
    const err = Object.assign(new Error("request rejected"), {
      gatewayCode: "INVALID_REQUEST",
      details: { reason: "APPROVAL_ALREADY_RESOLVED" },
    });
    expect(isApprovalStaleError(err)).toBe(true);
  });

  it("includes approval-not-found errors", () => {
    const err = Object.assign(new Error("approval not found"), {
      gatewayCode: "APPROVAL_NOT_FOUND",
    });
    expect(isApprovalStaleError(err)).toBe(true);
  });

  it("ignores transient errors", () => {
    expect(isApprovalStaleError(new Error("gateway unavailable"))).toBe(false);
  });
});

// A refusal is only this when both the code and the reason say so: FORBIDDEN alone is also a
// missing-scope failure, which would send the operator to an approver list for no reason.
describe("isApprovalAuthorityError", () => {
  const failure = (gatewayCode: string, reason?: string) =>
    Object.assign(new Error("refused"), {
      gatewayCode,
      ...(reason ? { details: { code: reason } } : {}),
    });

  it.each([
    ["FORBIDDEN", "APPROVAL_AUTHORITY_REQUIRED", true],
    ["FORBIDDEN", undefined, false],
    ["FORBIDDEN", "MISSING_SCOPE", false],
    ["INVALID_REQUEST", "APPROVAL_AUTHORITY_REQUIRED", false],
  ])("%s with reason %s is an authority refusal: %s", (code, reason, expected) => {
    expect(isApprovalAuthorityError(failure(code, reason))).toBe(expected);
  });
});

// Walking exec then plugin, a channel that authorizes one kind and not the other answers the
// wrong kind with a refusal, so a refusal has to keep the search going just as not-found does.
describe("isApprovalKindMismatchError", () => {
  it.each([
    [{ gatewayCode: "FORBIDDEN", details: { code: "APPROVAL_AUTHORITY_REQUIRED" } }, true],
    [{ gatewayCode: "INVALID_REQUEST", details: { reason: "APPROVAL_NOT_FOUND" } }, true],
    [{ gatewayCode: "UNAVAILABLE" }, false],
  ])("%j continues the search: %s", (fields, expected) => {
    expect(isApprovalKindMismatchError(Object.assign(new Error("x"), fields))).toBe(expected);
  });
});
