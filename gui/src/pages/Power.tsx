import WorkspaceFilesPage from "./workspace/WorkspaceFilesPage";

export default function Power() {
  return (
    <WorkspaceFilesPage
      featureKey="power"
      title="Power"
      description="Advanced agent capabilities and power tools. Stored under .micat/power/ as Markdown (Kiro-style Power tooling)."
      template={"# Power Tool\n\nDescription:\nCapabilities:\n- \n"}
    />
  );
}
