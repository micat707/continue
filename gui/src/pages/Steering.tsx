import WorkspaceFilesPage from "./workspace/WorkspaceFilesPage";

// Kiro-style frontmatter reference shown as comments in templates.
// File name is irrelevant for loading - only frontmatter decides.
const FRONTMATTER_HINT = `<!--
Frontmatter controls when this file is loaded (file name is irrelevant):

---
inclusion: always        # default: injected into every request
---

---
inclusion: fileMatch     # only when the referenced files match
fileMatchPattern: src/**/*.ts
---

Continue-native style also works: "globs" + "alwaysApply" frontmatter.
"manual" (via # references) is not supported yet.
-->

`;

export default function Steering() {
  return (
    <WorkspaceFilesPage
      featureKey="steering"
      title="Steering"
      description="Project guidance files that steer the agent. Workspace scope: <repo>/.micat/steering/ (takes precedence). Global scope: ~/.micat/steering/ (applies to all workspaces). Frontmatter decides when each file is loaded."
      enableGlobalScope
      template={`${FRONTMATTER_HINT}# Steering\n\nDescribe the conventions, tech stack, and constraints this project follows.\n`}
      templates={[
        {
          label: "Product (项目概览)",
          filename: "product.md",
          content: `${FRONTMATTER_HINT}# Product Overview\n\nDescribe what this product is, who the users are, and the core value it delivers.\n`,
        },
        {
          label: "Tech (技术偏好)",
          filename: "tech.md",
          content: `${FRONTMATTER_HINT}# Technical Preferences\n\nList frameworks, languages, libraries, and conventions the codebase should follow.\n`,
        },
        {
          label: "Structure (仓库结构)",
          filename: "structure.md",
          content: `${FRONTMATTER_HINT}# Repository Structure\n\nDescribe the main directories and the responsibility of each.\n`,
        },
        {
          label: "FileMatch (按文件生效)",
          filename: "api-rules.md",
          content: `---
inclusion: fileMatch
fileMatchPattern:
  - src/api/**/*.ts
  - "!**/*.test.ts"
---

${FRONTMATTER_HINT}# API Rules\n\nConventions that only apply when working with files matching the patterns above.\n`,
        },
      ]}
    />
  );
}
