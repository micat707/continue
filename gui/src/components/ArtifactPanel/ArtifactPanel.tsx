import React, { useContext } from "react";
import styled from "styled-components";
import { TrashIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import {
  removeArtifact,
  selectArtifacts,
  setActiveArtifact,
  setPanelOpen,
} from "../../redux/slices/artifactsSlice";
import { ArtifactView } from "./ArtifactView";

const Panel = styled.div<{ open: boolean }>`
  position: fixed;
  top: 0;
  right: 0;
  height: 100%;
  width: 420px;
  max-width: 90vw;
  background: var(--vsc-background);
  border-left: 1px solid var(--vsc-border);
  box-shadow: -4px 0 16px rgba(0, 0, 0, 0.35);
  transform: translateX(${(p) => (p.open ? "0" : "100%")});
  transition: transform 0.2s ease;
  z-index: 9000;
  display: flex;
  flex-direction: column;
`;

const Backdrop = styled.div<{ open: boolean }>`
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.25);
  opacity: ${(p) => (p.open ? 1 : 0)};
  pointer-events: ${(p) => (p.open ? "auto" : "none")};
  z-index: 8999;
`;

const Overlay = styled.div`
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.8);
  z-index: 10001;
  display: flex;
  flex-direction: column;
  padding: 2rem;
`;

const ViewerBody = styled.div`
  flex: 1;
  min-height: 0;
  overflow: auto;
  background: var(--vsc-background);
  border-radius: 8px;
  padding: 1.5rem;
`;

const ListItem = styled.button<{ active: boolean }>`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  text-align: left;
  padding: 0.6rem 0.9rem;
  border: 0;
  border-bottom: 1px solid var(--vsc-border);
  border-left: 3px solid
    ${(p) => (p.active ? "var(--vsc-primary)" : "transparent")};
  background: ${(p) =>
    p.active ? "var(--vsc-list-hoverBackground)" : "transparent"};
  color: inherit;
  cursor: pointer;
  &:hover {
    background: var(--vsc-list-hoverBackground);
  }
`;

export function ArtifactPanel() {
  const dispatch = useAppDispatch();
  const ideMessenger = useContext(IdeMessengerContext);
  const { items, panelOpen, activeArtifactId } =
    useAppSelector(selectArtifacts);
  const active = items.find((a) => a.id === activeArtifactId) ?? null;

  const handleDelete = (id: string, sessionId?: string) => {
    void ideMessenger
      .request("artifactDelete", { id, sessionId })
      .then((res) => {
        if (res.status === "success") dispatch(removeArtifact(id));
      })
      .catch(() => {});
  };

  return (
    <>
      <Backdrop
        open={panelOpen}
        onClick={() => dispatch(setPanelOpen(false))}
      />
      <Panel open={panelOpen}>
        <div className="flex items-center justify-between border-b border-[var(--vsc-border)] px-4 py-3">
          <h2 className="m-0 text-sm font-semibold">
            Artifacts ({items.length})
          </h2>
          <button
            aria-label="Close artifacts"
            onClick={() => dispatch(setPanelOpen(false))}
            className="cursor-pointer border-0 bg-transparent text-inherit"
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {items.length === 0 ? (
            <p className="p-4 text-sm opacity-70">
              No artifacts yet. The agent creates them with the create_artifact
              tool.
            </p>
          ) : (
            items.map((a) => (
              <ListItem
                key={a.id}
                active={a.id === activeArtifactId}
                onClick={() => dispatch(setActiveArtifact(a.id))}
              >
                <span className="text-base">📄</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{a.title}</span>
                  <span className="block text-xs opacity-60">
                    {a.kind} · {a.createdAt.slice(11, 19)}
                  </span>
                </span>
                <span
                  role="button"
                  aria-label="Delete artifact"
                  title="Delete artifact"
                  className="shrink-0 rounded p-1 opacity-50 hover:bg-[var(--vsc-list-hoverBackground)] hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete(a.id, a.sessionId);
                  }}
                >
                  <TrashIcon className="h-4 w-4" />
                </span>
              </ListItem>
            ))
          )}
        </div>
      </Panel>

      {active && (
        <Overlay onClick={() => dispatch(setActiveArtifact(null))}>
          <div className="mb-3 flex items-center justify-between text-white">
            <h3 className="m-0 text-base">{active.title}</h3>
            <button
              aria-label="Close viewer"
              onClick={() => dispatch(setActiveArtifact(null))}
              className="cursor-pointer border-0 bg-transparent text-inherit"
            >
              <XMarkIcon className="h-6 w-6" />
            </button>
          </div>
          <ViewerBody onClick={(e) => e.stopPropagation()}>
            <ArtifactView artifact={active} />
          </ViewerBody>
        </Overlay>
      )}
    </>
  );
}

export default ArtifactPanel;
