import React from "react";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import {
  selectArtifacts,
  setActiveArtifact,
  setPanelOpen,
} from "../../redux/slices/artifactsSlice";
import { ArtifactView } from "./ArtifactView";

/** Inline preview for `![title](kiro-artifact://id)` markdown images. */
export function ArtifactInline({ src, alt }: { src?: string; alt?: string }) {
  const dispatch = useAppDispatch();
  const items = useAppSelector((state) => selectArtifacts(state).items);

  if (!src || !/^(kiro-artifact|micat-artifact):\/\//.test(src)) return null;
  const id = src.replace(/^(kiro-artifact|micat-artifact):\/\//, "");
  const artifact = items.find((a) => a.id === id);
  if (!artifact) {
    return (
      <span className="text-xs opacity-60">[artifact {id} not loaded]</span>
    );
  }
  const visual = ["svg", "image", "mermaid"].includes(artifact.kind);

  return (
    <div
      className="artifact-inline my-2 cursor-pointer overflow-hidden rounded border border-[var(--vsc-border)]"
      onClick={() => {
        dispatch(setActiveArtifact(id));
        dispatch(setPanelOpen(true));
      }}
      title="Click to view artifact full screen"
    >
      <div className="flex items-center gap-1 border-b border-[var(--vsc-border)] px-2 py-1 text-xs opacity-70">
        <span>📄</span>
        <span className="truncate">{alt || artifact.title}</span>
      </div>
      <div className={visual ? "max-h-64 overflow-hidden p-2" : "hidden"}>
        {visual && <ArtifactView artifact={artifact} compact />}
      </div>
      {!visual && (
        <div className="p-2 text-xs opacity-70">
          {artifact.kind} artifact — click to open
        </div>
      )}
    </div>
  );
}

export default ArtifactInline;
