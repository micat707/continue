import React from "react";
import StyledMarkdownPreview from "../StyledMarkdownPreview";
import type { GuiArtifact } from "../../redux/slices/artifactsSlice";

/** Render a single artifact's content by kind. */
export function ArtifactView({
  artifact,
  compact = false,
}: {
  artifact: GuiArtifact;
  compact?: boolean;
}) {
  const { kind, content, filePath, format } = artifact;

  if (kind === "markdown") {
    return (
      <div className="prose prose-sm max-w-none">
        <StyledMarkdownPreview source={content} />
      </div>
    );
  }
  if (kind === "mermaid") {
    return (
      <div className="overflow-auto">
        <StyledMarkdownPreview source={`\`\`\`mermaid\n${content}\n\`\`\``} />
      </div>
    );
  }
  if (kind === "svg") {
    return (
      <div
        className="artifact-svg overflow-auto"
        dangerouslySetInnerHTML={{ __html: content }}
      />
    );
  }
  if (kind === "html") {
    return (
      <iframe
        title={artifact.title}
        sandbox=""
        srcDoc={content}
        className="h-full min-h-[300px] w-full border-0 bg-white"
      />
    );
  }
  if (kind === "code") {
    return (
      <StyledMarkdownPreview
        source={`\`\`\`${format || ""}\n${content}\n\`\`\``}
      />
    );
  }
  if (kind === "image") {
    return (
      <img
        src={`file://${filePath}`}
        alt={artifact.title}
        className="max-h-full max-w-full object-contain"
      />
    );
  }
  if (kind === "pdf" || kind === "office") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="opacity-80">
          {artifact.title} ({kind})
        </p>
        <a
          className="underline"
          href={`file://${filePath}`}
          target="_blank"
          rel="noreferrer"
        >
          Open file
        </a>
        <p className="text-xs opacity-60">{filePath}</p>
      </div>
    );
  }
  return (
    <pre
      className={
        compact ? "whitespace-pre-wrap text-xs" : "whitespace-pre-wrap"
      }
    >
      {content || filePath}
    </pre>
  );
}

export default ArtifactView;
