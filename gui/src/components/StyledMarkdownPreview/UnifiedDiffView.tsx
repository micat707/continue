interface UnifiedDiffViewProps {
  /** Unified diff text, optionally prefixed by a one-line success summary. */
  diff: string;
}

/**
 * Kiro-style inline diff: colored + / - rows with surrounding context, minus
 * the unified-diff metadata lines (`--- a/`, `+++ b/`, `@@ ... @@`). Shared by
 * EditOutcomeCard (markdown path) and GenericToolCallCard (native path) so
 * write tools render identically whichever route produced them.
 */
export function UnifiedDiffView({ diff }: UnifiedDiffViewProps) {
  const diffStart = diff.indexOf("--- a/");
  const body = (diffStart >= 0 ? diff.slice(diffStart) : diff).trimEnd();
  const lines = body.split("\n");

  return (
    <pre className="m-0 w-fit min-w-full text-xs leading-tight">
      {lines.map((line, index) => {
        if (
          line.startsWith("--- ") ||
          line.startsWith("+++ ") ||
          line.startsWith("@@")
        ) {
          return null;
        }
        const lineClass = line.startsWith("+")
          ? "border-l-4 border-green-600 bg-green-600/20"
          : line.startsWith("-")
            ? "border-l-4 border-red-900 bg-red-900/30"
            : "";
        return (
          <div key={index} className={`px-3 py-px font-mono ${lineClass}`}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}

export default UnifiedDiffView;
