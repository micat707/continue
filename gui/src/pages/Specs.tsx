import WorkspaceFilesPage from "./workspace/WorkspaceFilesPage";

export default function Specs() {
  return (
    <WorkspaceFilesPage
      featureKey="specs"
      title="Specs"
      description="Structured requirement/spec documents that drive implementation. Stored under .micat/specs/ as Markdown (Kiro-style spec workflow)."
      template={
        "# Spec\n\n## Requirements\n- \n\n## Approach\n- \n\n## Tasks\n- [ ] \n"
      }
    />
  );
}
