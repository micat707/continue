import { ToolCallState } from "core";
import { BuiltInToolNames } from "core/tools/builtIn";
import { EditOperation } from "core/tools/definitions/multiEdit";
import { CreateFile } from "./CreateFile";
import { EditFile } from "./EditFile";
import { FindAndReplaceDisplay } from "./FindAndReplace";
import { ReadFile } from "./ReadFile";
import { RunTerminalCommand } from "./RunTerminalCommand";
import { UserInputCard } from "./UserInputCard";
import { ExecutePwshCard } from "./ExecutePwshCard";
import { SpecWorkflowCard } from "./SpecWorkflowCard";
import { GenericToolCallCard } from "./GenericToolCallCard";
import { SubagentCard } from "./SubagentCard";

function FunctionSpecificToolCallDiv({
  toolCallState,
  historyIndex,
}: {
  toolCallState: ToolCallState;
  historyIndex: number;
}) {
  const args = toolCallState.parsedArgs;
  const processedArgs = toolCallState.processedArgs;
  const toolCall = toolCallState.toolCall;

  switch (toolCall.function?.name) {
    case BuiltInToolNames.CreateNewFile:
      return (
        <CreateFile
          relativeFilepath={args?.filepath ?? ""}
          fileContents={args?.contents ?? ""}
          historyIndex={historyIndex}
          toolCallState={toolCallState}
        />
      );
    case BuiltInToolNames.ReadFile:
    case "read_files":
      return (
        <ReadFile toolCallState={toolCallState} historyIndex={historyIndex} />
      );
    case BuiltInToolNames.EditExistingFile:
      return (
        <EditFile
          relativeFilePath={processedArgs?.filepath ?? args?.filepath ?? ""}
          changes={processedArgs?.changes ?? args?.changes ?? ""}
          toolCallId={toolCall.id}
          historyIndex={historyIndex}
        />
      );
    case BuiltInToolNames.SingleFindAndReplace:
      const edits: EditOperation[] = [
        {
          old_string: processedArgs?.old_string ?? args?.old_string ?? "",
          new_string: processedArgs?.new_string ?? args?.new_string ?? "",
          replace_all: processedArgs?.replace_all ?? args?.replace_all,
        },
      ];
      return (
        <FindAndReplaceDisplay
          editingFileContents={processedArgs?.editingFileContents}
          fileUri={processedArgs?.fileUri ?? ""}
          newFileContents={processedArgs?.newFileContents}
          relativeFilePath={processedArgs?.filepath ?? args?.filepath ?? ""}
          edits={edits}
          toolCallId={toolCall.id}
          historyIndex={historyIndex}
        />
      );
    case BuiltInToolNames.MultiEdit:
      return (
        <FindAndReplaceDisplay
          editingFileContents={processedArgs?.editingFileContents}
          relativeFilePath={processedArgs?.filepath ?? args?.filepath ?? ""}
          fileUri={processedArgs?.fileUri ?? ""}
          newFileContents={processedArgs?.newFileContents}
          edits={processedArgs?.edits ?? args?.edits ?? []}
          toolCallId={toolCall.id}
          historyIndex={historyIndex}
        />
      );
    case BuiltInToolNames.RunTerminalCommand:
      return (
        <RunTerminalCommand
          command={args?.command ?? ""}
          toolCallState={toolCallState}
          toolCallId={toolCall.id}
        />
      );
    case "user_input":
      return <UserInputCard toolCallState={toolCallState} />;
    case "execute_pwsh":
      return <ExecutePwshCard toolCallState={toolCallState} />;
    case "start_spec_workflow":
    case "run_spec_tasks":
      return <SpecWorkflowCard toolCallState={toolCallState} />;
    case "invoke_sub_agent":
      return <SubagentCard toolCallState={toolCallState} />;
    // Every remaining DeepAgent tool (fs_write, fs_append, str_replace,
    // delete_file, file_search, grep_search, list_directory, web_*, DAG task
    // tools, sub-agent, Kiro extra tools, mcp__*) lands here. The generic card
    // is Kiro's DefaultToolCall shape plus a clickable file-label and an inline
    // unified-diff view, so no tool renders as a blank row.
    default:
      return <GenericToolCallCard toolCallState={toolCallState} />;
  }
}

export default FunctionSpecificToolCallDiv;
