import { visit } from "unist-util-visit";

interface TextRun {
  text: string;
  props: Record<string, any> | null;
}

/**
 * Flatten a highlighted code node's children into styled text runs. Each run
 * keeps the className/properties of the nearest `hljs-*` span so syntax
 * colouring survives the line split.
 */
function collectRuns(
  node: any,
  inherited: Record<string, any> | null,
  out: TextRun[],
) {
  if (!node) {
    return;
  }
  if (node.type === "text") {
    out.push({ text: node.value ?? "", props: inherited });
    return;
  }
  if (Array.isArray(node.children)) {
    const next =
      node.type === "element" && node.properties
        ? { ...(inherited ?? {}), ...node.properties }
        : inherited;
    for (const child of node.children) {
      collectRuns(child, next, out);
    }
  }
}

function runsToLines(runs: TextRun[]): any[][] {
  const lines: any[][] = [[]];
  for (const run of runs) {
    const parts = run.text.split("\n");
    parts.forEach((part, index) => {
      if (index > 0) {
        lines.push([]);
      }
      if (part.length === 0) {
        return;
      }
      if (run.props && Object.keys(run.props).length > 0) {
        lines[lines.length - 1].push({
          type: "element",
          tagName: "span",
          properties: run.props,
          children: [{ type: "text", value: part }],
        });
      } else {
        lines[lines.length - 1].push({ type: "text", value: part });
      }
    });
  }
  // A trailing newline produces one empty line; drop it like Kiro does.
  if (lines.length > 1 && lines[lines.length - 1].length === 0) {
    lines.pop();
  }
  return lines;
}

/**
 * Split every fenced code block into one `<span class="code-line">` per line.
 * The line number itself is rendered by CSS (`.code-line::before`) and is
 * scoped to Kiro-style code blocks, so edit/apply blocks are unaffected.
 */
export function rehypeCodeLineNumbers() {
  return (tree: any) => {
    visit(tree, "element", (node: any) => {
      if (node.tagName !== "code") {
        return;
      }
      const className = node.properties?.className;
      const hasLanguage =
        Array.isArray(className) &&
        className.some((value) => String(value).startsWith("language-"));
      if (!hasLanguage || !Array.isArray(node.children)) {
        return;
      }

      const runs: TextRun[] = [];
      for (const child of node.children) {
        collectRuns(child, null, runs);
      }
      const lines = runsToLines(runs);

      node.children = lines.map((children, index) => ({
        type: "element",
        tagName: "span",
        properties: {
          className: ["code-line"],
          "data-line": String(index + 1),
        },
        children,
      }));
    });
  };
}
