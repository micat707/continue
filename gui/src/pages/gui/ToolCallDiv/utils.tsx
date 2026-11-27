import * as Icons from "@heroicons/react/24/outline";
import {
  ContextItem,
  ContextItemWithId,
  ToolCallState,
  ToolStatus,
} from "core";
import { ComponentType, SVGProps } from "react";
import { vscButtonBackground } from "../../../components";
import Spinner from "../../../components/gui/Spinner";

// Helper function to determine the intro verb based on tool call status
export function getStatusIntro(
  status: ToolCallState["status"],
  isInstant?: boolean,
): string {
  if (status === "done" || (isInstant && status === "calling")) {
    return "";
  }

  switch (status) {
    case "generating":
      return "will";
    case "generated":
      return "wants to";
    case "calling":
      return "is";
    case "canceled":
    case "errored":
      return "tried to";
    default:
      return "";
  }
}

// Helper function to get the appropriate verb for group actions
export function getGroupActionVerb(toolCallStates: ToolCallState[]): string {
  if (toolCallStates.length === 0) return "Performing";

  // Get the most "active" status from all tool calls
  const statuses = toolCallStates.map((state) => state.status);

  // Priority order: calling > generating > generated > done > errored/canceled
  if (statuses.includes("calling")) {
    return "Performing";
  } else if (statuses.includes("generating")) {
    return "Generating";
  } else if (statuses.includes("generated")) {
    return "Pending";
  } else if (statuses.some((s) => s === "done")) {
    return "Performed";
  } else if (statuses.some((s) => s === "errored" || s === "canceled")) {
    return "Attempted";
  }

  return "Performing";
}

type IconName = keyof typeof Icons;

type Icon = ComponentType<SVGProps<SVGSVGElement>> | undefined;

export function getIconByName(name: string): Icon | null {
  if (name in Icons) {
    return Icons[name as IconName] as Icon;
  }
  return null;
}

/**
 * Kiro's ToolCallStatus → agent-icon status mapping (same for every tool kind):
 *   completed   -> accepted (green)
 *   failed      -> error (red)
 *   in_progress -> inProgress spinner (theme progress color)
 *   pending     -> pending (yellow)
 *   canceled    -> canceled (neutral; Kiro has no tool-card case for it)
 *
 * Our ToolStatus uses done/errored/calling/generated/generating/canceled, so
 * map those to Kiro's four states before choosing CSS classes/icons.
 */
export type KiroToolIconStatus =
  | "accepted"
  | "error"
  | "inProgress"
  | "pending"
  | "canceled";

export function getKiroToolIconStatus(
  status: ToolStatus | undefined,
): KiroToolIconStatus {
  switch (status) {
    case "done":
      return "accepted";
    case "errored":
      return "error";
    case "calling":
    case "generating":
      return "inProgress";
    case "generated":
      return "pending";
    case "canceled":
      return "canceled";
    default:
      return "pending";
  }
}

export function getKiroToolStatusClass(status: ToolStatus | undefined): string {
  return `agent-icon-${getKiroToolIconStatus(status)}`;
}

export function isKiroToolInProgress(status: ToolStatus | undefined): boolean {
  return getKiroToolIconStatus(status) === "inProgress";
}

export function getStatusIcon(state: ToolStatus) {
  switch (state) {
    case "generating":
    case "calling":
      return <Spinner />;
    case "generated":
      return <Icons.ArrowRightIcon color={vscButtonBackground} />;
    case "done":
      return <Icons.CheckIcon className="text-success" />;
    case "canceled":
    case "errored":
      return <Icons.XMarkIcon className="text-error" />;
  }
}

export function toolCallStateToContextItems(
  toolCallState: ToolCallState | undefined,
): ContextItemWithId[] {
  if (!toolCallState) {
    return [];
  }
  return (
    toolCallState.output?.map((ctxItem) =>
      toolCallCtxItemToCtxItemWithId(ctxItem, toolCallState.toolCallId),
    ) ?? []
  );
}

export function toolCallCtxItemToCtxItemWithId(
  ctxItem: ContextItem,
  toolCallId: string,
): ContextItemWithId {
  return {
    ...ctxItem,
    id: {
      providerTitle: "toolCall",
      itemId: toolCallId,
    },
  };
}
