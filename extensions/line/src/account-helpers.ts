// Line helper module supports account helpers behavior.
type LineCredentialAccount = {
  channelAccessToken?: string;
  channelSecret?: string;
  tokenStatus?: "available" | "configured_unavailable" | "missing";
  signingSecretStatus?: "available" | "configured_unavailable" | "missing";
};

/**
 * Reports whether an account has enough configuration to run, which is what every
 * caller of this asks: the status summary, the account snapshot, the setup wizard,
 * and the message tool offered to the model.
 *
 * A credential resolves to "configured_unavailable" when the config named a source
 * that could not be read. That is not enough to run — the send fails and the channel
 * refuses to start — so only resolved credentials count.
 */
export function hasLineCredentials(account: LineCredentialAccount): boolean {
  if (account.tokenStatus && account.signingSecretStatus) {
    return account.tokenStatus === "available" && account.signingSecretStatus === "available";
  }
  return Boolean(account.channelAccessToken?.trim() && account.channelSecret?.trim());
}

export function parseLineAllowFromId(raw: string): string | null {
  const trimmed = raw.trim().replace(/^line:(?:user:)?/i, "");
  if (!/^U[a-f0-9]{32}$/i.test(trimmed)) {
    return null;
  }
  return trimmed;
}
