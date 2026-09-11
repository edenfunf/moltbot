// Line plugin module implements channel access token behavior.
import type { ResolvedLineAccount } from "./types.js";

type LineTokenAccount = Pick<
  ResolvedLineAccount,
  "accountId" | "channelAccessToken" | "tokenStatus" | "credentialDiagnostics"
>;

export function resolveLineChannelAccessToken(
  explicit: string | undefined,
  params: LineTokenAccount,
): string {
  if (explicit?.trim()) {
    return explicit.trim();
  }
  if (!params.channelAccessToken) {
    throw new Error(
      params.tokenStatus === "configured_unavailable"
        ? describeUnavailableToken(params)
        : `LINE channel access token missing for account "${params.accountId}" (set channels.line.channelAccessToken or LINE_CHANNEL_ACCESS_TOKEN).`,
    );
  }
  return params.channelAccessToken.trim();
}

// A named tokenFile that cannot be used resolves to nothing too; sending that operator
// to set channelAccessToken points at a key that was never the problem. The account
// already records which key failed and why, and a symlink reads fine from a shell.
function describeUnavailableToken(params: LineTokenAccount): string {
  const diagnostic = params.credentialDiagnostics?.find((entry) =>
    entry.path.endsWith(".tokenFile"),
  );
  const failure = diagnostic
    ? `${diagnostic.path} could not be used (${diagnostic.reason})`
    : "its tokenFile could not be used";
  return `LINE channel access token configured for account "${params.accountId}" is unavailable: ${failure}. Point it at a readable regular file; symlinks are rejected.`;
}
