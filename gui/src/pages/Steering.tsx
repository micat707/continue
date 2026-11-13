import WorkspaceFilesPage from "./workspace/WorkspaceFilesPage";

export default function Steering() {
  return (
    <WorkspaceFilesPage
      featureKey="steering"
      title="Steering"
      description="Project guidance files that steer the agent. Stored under .micat/steering/ as Markdown. Global scope lives in your home dir, Workspace scope at the repo root."
      template={
        "# Steering\n\nDescribe the conventions, tech stack, and constraints this project follows.\n"
      }
      templates={[
        {
          label: "Product (项目概览)",
          filename: "product.md",
          content:
            "# Product Overview\n\nDescribe what this product is, who the users are, and the core value it delivers.\n",
        },
        {
          label: "Tech (技术偏好)",
          filename: "tech.md",
          content:
            "# Technical Preferences\n\nList frameworks, languages, libraries, and conventions the codebase should follow.\n",
        },
        {
          label: "Structure (仓库结构)",
          filename: "structure.md",
          content:
            "# Repository Structure\n\nDescribe the main directories and the responsibility of each.\n",
        },
      ]}
    />
  );
}
