// Anthropic system-prompt block accounting: the native cache-marker count the
// payload policy budgets against. The blocks themselves are built by the payload
// policy, which owns the cache-boundary rules.

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
