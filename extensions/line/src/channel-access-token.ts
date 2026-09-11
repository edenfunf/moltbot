// Line plugin module implements channel access token behavior.
import type { ResolvedLineAccount } from "./types.js";

export function resolveLineChannelAccessToken(
  explicit: string | undefined,
  params: Pick<ResolvedLineAccount, "accountId" | "channelAccessToken" | "tokenStatus">,
): string {
  if (explicit?.trim()) {
    return explicit.trim();
  }
  if (!params.channelAccessToken) {
    // A named tokenFile that cannot be read resolves to nothing too; sending that
    // operator to set channelAccessToken points at a key that was never the problem.
    throw new Error(
      params.tokenStatus === "configured_unavailable"
        ? `LINE channel access token configured for account "${params.accountId}" is unavailable: its tokenFile could not be read. Restore the file, or point tokenFile at a path that can be read.`
        : `LINE channel access token missing for account "${params.accountId}" (set channels.line.channelAccessToken or LINE_CHANNEL_ACCESS_TOKEN).`,
    );
  }
  return params.channelAccessToken.trim();
}
