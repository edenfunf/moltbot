// Line plugin module implements doctor behavior.
import { firstDefined } from "openclaw/plugin-sdk/allow-from";
import type {
  ChannelDoctorAdapter,
  ChannelDoctorEmptyAllowlistAccountContext,
} from "openclaw/plugin-sdk/channel-contract";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

type LineGroupCoverage = {
  covered: boolean;
  /** Enabled groups with no sender allowlist anywhere in their resolved config. */
  uncovered: string[];
  /** Enabled groups whose own empty `allowFrom` masks every wider allowlist. */
  overridden: string[];
};

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
    return { covered: false, uncovered: [], overridden: [] };
  }

  const defaults = entries.find(([id]) => id === GROUP_DEFAULTS_KEY)?.[1];
  const resolveAllowFrom = (group?: Record<string, unknown>): unknown =>
    firstDefined(group?.allowFrom, params.groupAllowFrom);

  // A group with no entry of its own resolves to the defaults node alone.
  let covered = defaults?.enabled !== false && hasAllowFromEntries(resolveAllowFrom(defaults));

  const uncovered: string[] = [];
  const overridden: string[] = [];
  for (const [id, group] of entries) {
    if (id === GROUP_DEFAULTS_KEY) {
      continue;
    }
    const effective = defaults ? { ...defaults, ...group } : group;
    if (effective.enabled === false) {
      continue;
    }
    const allowFrom = resolveAllowFrom(effective);
    if (hasAllowFromEntries(allowFrom)) {
      covered = true;
    } else if (allowFrom === undefined) {
      uncovered.push(id);
    } else {
      // An authored empty list wins over the defaults node and the channel-wide
      // list, so pointing the operator at either of those would not help.
      overridden.push(id);
    }
  }
  return { covered, uncovered, overridden };
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
function formatGroupIds(ids: string[]): string {
  return ids.map((id) => `"${id}"`).join(", ");
}

function collectLineEmptyAllowlistExtraWarnings(
  params: ChannelDoctorEmptyAllowlistAccountContext,
): string[] {
  if (!isLineGroupAllowlistScope(params)) {
    return [];
  }
  const { covered, uncovered, overridden } = readLineGroupCoverage(params);
  const warnings: string[] = [];

  if (overridden.length > 0) {
    const single = overridden.length === 1;
    warnings.push(
      `- ${params.prefix}.groups: ${single ? "group" : "groups"} ${formatGroupIds(overridden)} ${single ? "sets" : "set"} an empty allowFrom, which overrides ${params.prefix}.groups."*".allowFrom and ${params.prefix}.groupAllowFrom — messages there are silently dropped. Add sender IDs to ${single ? "that group's" : "each group's"} own allowFrom, or remove the key so it inherits.`,
    );
  }

  // When nothing is served the shared warning already states the whole channel is
  // dropping group messages, so only the narrower cases are worth adding.
  if (covered && uncovered.length > 0) {
    const single = uncovered.length === 1;
    warnings.push(
      `- ${params.prefix}.groups: ${single ? "group" : "groups"} ${formatGroupIds(uncovered)} ${single ? "has" : "have"} no sender allowlist — messages there are silently dropped while your other groups keep working. Add sender IDs under ${params.prefix}.groups.<id>.allowFrom, or under ${params.prefix}.groups."*".allowFrom to cover every group, or to ${params.prefix}.groupAllowFrom.`,
    );
  }

  return warnings;
}

export const lineDoctor: ChannelDoctorAdapter = {
  collectEmptyAllowlistExtraWarnings: collectLineEmptyAllowlistExtraWarnings,
  shouldSkipDefaultEmptyGroupAllowlistWarning: (params) =>
    isLineGroupAllowlistScope(params) && readLineGroupCoverage(params).covered,
};
