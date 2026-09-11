// Line plugin module implements channel shared behavior.
import { describeWebhookAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import { hasLineCredentials, hasUsableLineCredentials } from "./account-helpers.js";
import { lineConfigAdapter } from "./config-adapter.js";
import { LineChannelConfigSchema } from "./config-schema.js";
import type { ResolvedLineAccount } from "./types.js";

const lineChannelMeta = {
  id: "line",
  label: "LINE",
  selectionLabel: "LINE (Messaging API)",
  detailLabel: "LINE Bot",
  docsPath: "/channels/line",
  docsLabel: "line",
  blurb: "LINE Messaging API bot for Japan/Taiwan/Thailand markets.",
  systemImage: "message.fill",
} as const;

/** Names each credential the config points at but that could not be read. */
function describeLineUnconfiguredReason(account: ResolvedLineAccount): string {
  const unavailable = [
    account.tokenStatus === "configured_unavailable" ? `token ${account.tokenSource}` : "",
    account.signingSecretStatus === "configured_unavailable"
      ? `channel secret ${account.signingSecretSource}`
      : "",
  ].filter(Boolean);
  return unavailable.length > 0
    ? `not configured: ${unavailable.join(" and ")} ${unavailable.length > 1 ? "are" : "is"} configured but unavailable`
    : "not configured";
}

export const lineChannelPluginCommon = {
  meta: {
    ...lineChannelMeta,
    quickstartAllowFrom: true,
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    reactions: false,
    threads: false,
    media: true,
    nativeCommands: false,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.line"] },
  configSchema: LineChannelConfigSchema,
  config: {
    ...lineConfigAdapter,
    // Running needs both credentials resolved. A configured but unreadable credential
    // stays configured in describeAccount below and is named by the reason instead.
    isConfigured: (account: ResolvedLineAccount) => hasUsableLineCredentials(account),
    unconfiguredReason: (account: ResolvedLineAccount) => describeLineUnconfiguredReason(account),
    describeAccount: (account: ResolvedLineAccount) =>
      describeWebhookAccountSnapshot({
        account,
        configured: hasLineCredentials(account),
        extra: {
          tokenSource: account.tokenSource ?? undefined,
          signingSecretSource: account.signingSecretSource ?? undefined,
          tokenStatus: account.tokenStatus,
          signingSecretStatus: account.signingSecretStatus,
        },
      }),
  },
} satisfies Pick<
  ChannelPlugin<ResolvedLineAccount>,
  "meta" | "capabilities" | "reload" | "configSchema" | "config"
>;
