/**
 * Rebuild the "before"/"after" text of a change window from the compact
 * unified diff produced by the filesystem backend's buildUnifiedDiff().
 *
 * That diff is not an LCS diff: it emits, in order, leading context lines,
 * all removed lines, all added lines, then trailing context lines. So the two
 * sides are simply `prefix + removed + suffix` and `prefix + added + suffix`.
 *
 * Only the changed window (context + changes) is reconstructed, not the whole
 * file. That is enough for a side-by-side review and avoids shipping full file
 * contents through the chat stream. Line numbers therefore start at 1.
 */
export interface UnifiedDiffPair {
  original: string;
  modified: string;
}

export function splitUnifiedDiff(diff: string): UnifiedDiffPair | undefined {
  const prefix: string[] = [];
  const removed: string[] = [];
  const added: string[] = [];
  const suffix: string[] = [];
  let sawChange = false;

  for (const line of diff.split("\n")) {
    if (
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("@@") ||
      line.startsWith("…")
    ) {
      continue;
    }

    const marker = line.charAt(0);
    const body = line.slice(1);
    if (marker === "-") {
      sawChange = true;
      removed.push(body);
    } else if (marker === "+") {
      sawChange = true;
      added.push(body);
    } else if (marker === " ") {
      (sawChange ? suffix : prefix).push(body);
    }
    // Unknown markers (e.g. a bare empty line) carry no diff information.
  }

  if (!sawChange) return undefined;
  return {
    original: [...prefix, ...removed, ...suffix].join("\n"),
    modified: [...prefix, ...added, ...suffix].join("\n"),
  };
}
