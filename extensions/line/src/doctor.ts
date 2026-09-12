// Line plugin module implements doctor behavior.
import { firstDefined } from "openclaw/plugin-sdk/allow-from";
import type {
  ChannelDoctorAdapter,
  ChannelDoctorEmptyAllowlistAccountContext,
} from "openclaw/plugin-sdk/channel-contract";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

type LineGroupCoverage = { covered: boolean; uncovered: string[] };

const GROUP_DEFAULTS_KEY = "*";

function hasAllowFromEntries(values?: unknown): boolean {
  return Array.isArray(values) && values.length > 0;
}

/**
 * Read the group map one scope at a time, the way account resolution does.
 *
 * `mergeAccountConfig` spreads account keys over channel keys and LINE declares no
 * nested object keys, so an account that authors `groups` replaces the channel-level
 * map outright instead of merging entry by entry. Reading both scopes together would
 * credit an account with groups its runtime never sees.
 */
function readGroupEntries(
  account?: Record<string, unknown>,
  parent?: Record<string, unknown>,
): [string, Record<string, unknown>][] {
  const groups = isRecord(account?.groups) ? account.groups : parent?.groups;
  if (!isRecord(groups)) {
    return [];
  }
  return Object.entries(groups).filter((entry): entry is [string, Record<string, unknown>] =>
    isRecord(entry[1]),
  );
}

/**
 * Group coverage as LINE's admission gate computes it.
 *
 * `resolveLineGroupConfigEntry` treats `groups["*"]` as a defaults node rather than a
 * rival entry, and admission reads `firstDefined(groupConfig.allowFrom, groupAllowFrom)`.
 * A group switched off with `enabled: false` is refused before any allowlist applies,
 * so it is neither covered nor a gap.
 */
function inspectLineGroupCoverage(params: {
  account: Record<string, unknown>;
  parent?: Record<string, unknown>;
  groupAllowFrom?: unknown;
}): LineGroupCoverage {
  const entries = readGroupEntries(params.account, params.parent);
  if (entries.length === 0) {
    return { covered: false, uncovered: [] };
  }

  const defaultsAllowFrom = entries.find(([id]) => id === GROUP_DEFAULTS_KEY)?.[1]?.allowFrom;
  // The defaults node and a channel-wide allowlist both reach every group, including
  // groups that have no entry of their own.
  if (hasAllowFromEntries(defaultsAllowFrom) || hasAllowFromEntries(params.groupAllowFrom)) {
    return { covered: true, uncovered: [] };
  }

  const named = entries.filter(
    ([id, group]) => id !== GROUP_DEFAULTS_KEY && group.enabled !== false,
  );
  const uncovered = named
    .filter(([, group]) => !hasAllowFromEntries(firstDefined(group.allowFrom, defaultsAllowFrom)))
    .map(([id]) => id);
  return { covered: named.length > uncovered.length, uncovered };
}

function readLineGroupCoverage(
  params: ChannelDoctorEmptyAllowlistAccountContext,
): LineGroupCoverage {
  const { account, parent } = params;
  return inspectLineGroupCoverage({
    account,
    ...(parent ? { parent } : {}),
    groupAllowFrom: firstDefined(account.groupAllowFrom, parent?.groupAllowFrom),
  });
}

function readGroupPolicy(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isLineGroupAllowlistScope(params: ChannelDoctorEmptyAllowlistAccountContext): boolean {
  return (
    params.channelName === "line" &&
    (readGroupPolicy(params.account.groupPolicy) ?? readGroupPolicy(params.parent?.groupPolicy)) ===
      "allowlist"
  );
}

/**
 * Replace the shared warning when per-group allowlists make its claim untrue.
 *
 * The shared warning states every group message is dropped, which stops being true once
 * one group carries its own `allowFrom`. Suppressing it alone would hide the groups that
 * really are dropped, so name those here instead.
 */
function collectLineEmptyAllowlistExtraWarnings(
  params: ChannelDoctorEmptyAllowlistAccountContext,
): string[] {
  if (!isLineGroupAllowlistScope(params)) {
    return [];
  }
  const { covered, uncovered } = readLineGroupCoverage(params);
  if (!covered || uncovered.length === 0) {
    return [];
  }
  const names = uncovered.map((id) => `"${id}"`).join(", ");
  const single = uncovered.length === 1;
  return [
    `- ${params.prefix}.groups: ${single ? "group" : "groups"} ${names} ${single ? "has" : "have"} no sender allowlist — messages there are silently dropped while your other groups keep working. Add sender IDs under ${params.prefix}.groups.<id>.allowFrom, or under ${params.prefix}.groups."*".allowFrom to cover every group, or to ${params.prefix}.groupAllowFrom.`,
  ];
}

export const lineDoctor: ChannelDoctorAdapter = {
  collectEmptyAllowlistExtraWarnings: collectLineEmptyAllowlistExtraWarnings,
  shouldSkipDefaultEmptyGroupAllowlistWarning: (params) =>
    isLineGroupAllowlistScope(params) && readLineGroupCoverage(params).covered,
};
