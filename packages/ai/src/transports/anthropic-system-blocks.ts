// Anthropic system-prompt blocks: billing routing, cache-boundary splitting, and
// the marker count the payload policy budgets against.
import type {
  CacheControlEphemeral,
  TextBlockParam,
} from "@anthropic-ai/sdk/resources/messages.js";
import { ANTHROPIC_CLAUDE_CODE_BILLING_SYSTEM_BLOCK } from "../providers/anthropic-model-contract.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import {
  splitSystemPromptCacheBoundary,
  stripSystemPromptCacheBoundary,
} from "../utils/system-prompt-cache-boundary.js";

export function buildAnthropicSystemBlocks(
  systemPrompt: string | undefined,
  isOAuthTokenResult: boolean,
  cacheControl: CacheControlEphemeral | undefined,
): TextBlockParam[] | undefined {
  const blocks: TextBlockParam[] = [];
  if (isOAuthTokenResult) {
    // Anthropic uses this first system block to route Claude subscription OAuth billing.
    blocks.push({
      type: "text",
      text: ANTHROPIC_CLAUDE_CODE_BILLING_SYSTEM_BLOCK,
    });
    blocks.push({
      type: "text",
      text: "You are Claude Code, Anthropic's official CLI for Claude.",
      ...(cacheControl ? { cache_control: cacheControl } : {}),
    });
  }
  if (systemPrompt) {
    blocks.push(...buildSystemPromptBlocks(systemPrompt, cacheControl));
  }
  return blocks.length > 0 ? blocks : undefined;
}

function buildSystemPromptBlocks(
  systemPrompt: string,
  cacheControl: CacheControlEphemeral | undefined,
): TextBlockParam[] {
  if (!cacheControl) {
    return [
      { type: "text", text: sanitizeSurrogates(stripSystemPromptCacheBoundary(systemPrompt)) },
    ];
  }

  const split = splitSystemPromptCacheBoundary(systemPrompt);
  if (!split) {
    return [
      {
        type: "text",
        text: sanitizeSurrogates(systemPrompt),
        cache_control: cacheControl,
      },
    ];
  }

  const blocks: TextBlockParam[] = [];
  if (split.stablePrefix) {
    blocks.push({
      type: "text",
      text: sanitizeSurrogates(split.stablePrefix),
      cache_control: cacheControl,
    });
  }
  if (split.dynamicSuffix) {
    blocks.push({ type: "text", text: sanitizeSurrogates(split.dynamicSuffix) });
  }
  return blocks.length > 0 ? blocks : [{ type: "text", text: "" }];
}

export function countNativeCacheControlMarkers(blocks: unknown): number {
  if (!Array.isArray(blocks)) {
    return 0;
  }

  let count = 0;
  for (const block of blocks) {
    if (block && typeof block === "object" && "cache_control" in block) {
      count += 1;
    }
  }
  return count;
}
