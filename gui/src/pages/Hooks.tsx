import WorkspaceFilesPage from "./workspace/WorkspaceFilesPage";

export default function Hooks() {
  return (
    <WorkspaceFilesPage
      featureKey="hooks"
      title="Hooks"
      description="Event-driven automations that run around agent actions. Stored under .micat/hooks/ as Markdown (Kiro-style hook system)."
      template={"# Hook\n\nTrigger: session.start\n\nAction:\n- \n"}
    />
  );
}
