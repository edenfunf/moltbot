// Line tests cover what a credential that cannot be read is allowed to claim.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasLineCredentials } from "./account-helpers.js";
import { resolveLineAccount } from "./accounts.js";
import { lineMessageActions } from "./rich-messages.js";

let dir: string;
let missing: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "line-credential-availability-"));
  missing = join(dir, "not-created.txt");
  writeFileSync(join(dir, "token.txt"), "a-real-token");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function lineCfg(line: Record<string, unknown>): OpenClawConfig {
  return { channels: { line: { enabled: true, ...line } } } as OpenClawConfig;
}

function accountFor(line: Record<string, unknown>) {
  return resolveLineAccount({ cfg: lineCfg(line), accountId: "default" });
}

describe("an account whose credential file cannot be read", () => {
  it("does not count as enough configuration to run", () => {
    const account = accountFor({ tokenFile: missing, channelSecret: "secret" });

    // The status itself is the point: the config named a source, so this is neither
    // "missing" nor usable, and only the second of those may run.
    expect(account.tokenStatus).toBe("configured_unavailable");
    expect(hasLineCredentials(account)).toBe(false);
  });

  it("does not count when the signing secret is the unreadable one", () => {
    const account = accountFor({ channelAccessToken: "token", secretFile: missing });

    expect(account.signingSecretStatus).toBe("configured_unavailable");
    expect(hasLineCredentials(account)).toBe(false);
  });

  it("keeps offering the message tool while both credentials resolve", () => {
    const account = accountFor({ channelAccessToken: "token", channelSecret: "secret" });

    expect(hasLineCredentials(account)).toBe(true);
    expect(
      lineMessageActions.describeMessageTool?.({
        cfg: lineCfg({ channelAccessToken: "token", channelSecret: "secret" }),
        accountId: "default",
      } as never)?.actions,
    ).toEqual(["send"]);
  });

  it("withholds the message tool the model would otherwise be told it can use", () => {
    // Offering send here hands the model a tool whose every call fails: the channel
    // refuses to start on the same credentials.
    expect(
      lineMessageActions.describeMessageTool?.({
        cfg: lineCfg({ tokenFile: missing, channelSecret: "secret" }),
        accountId: "default",
      } as never)?.actions,
    ).toEqual([]);
  });

  it("still reports an account with no credentials at all as unconfigured", () => {
    // The branch that already worked; it has to keep working after the change.
    const account = accountFor({});

    expect(account.tokenStatus).toBe("missing");
    expect(hasLineCredentials(account)).toBe(false);
  });

  it("falls back to the raw values when no credential status was resolved", () => {
    // Callers that build an account by hand carry no status fields, and the shape
    // they do carry still has to answer.
    expect(hasLineCredentials({ channelAccessToken: "token", channelSecret: "secret" })).toBe(true);
    expect(hasLineCredentials({ channelAccessToken: "token" })).toBe(false);
  });
});
