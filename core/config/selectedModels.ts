import { ModelRole } from "@continuedev/config-yaml";

import { ContinueConfig, ILLM } from "..";
import { LLMConfigurationStatuses } from "../llm/constants";
import {
  GlobalContext,
  GlobalContextModelSelections,
} from "../util/GlobalContext";

export function rectifySelectedModelsFromGlobalContext(
  continueConfig: ContinueConfig,
  profileId: string,
): ContinueConfig {
  const configCopy = { ...continueConfig };

  const globalContext = new GlobalContext();
  const currentSelectedModels = globalContext.get("selectedModelsByProfileId");
  const currentForProfile: GlobalContextModelSelections =
    currentSelectedModels?.[profileId] ?? {};

  let fellBack = false;

  // Resolve the chat model first so that apply/edit can fall back to it.
  // Previously, when a role (e.g. apply/edit) had no explicit selection, it
  // defaulted to the first model declaring that role — which ignored the model
  // the user actually picked in the chat dropdown and silently routed edits to
  // an arbitrary model. Now apply/edit fall back to the user's chat model
  // unless they explicitly choose a different one.
  let chatModel: ILLM | null = null;
  const chatSelection = currentForProfile["chat"] ?? null;
  if (chatSelection) {
    const match = continueConfig.modelsByRole.chat.find(
      (m) => m.title === chatSelection,
    );
    if (match) {
      chatModel = match;
    }
  }
  if (!chatModel && continueConfig.modelsByRole.chat.length > 0) {
    chatModel = continueConfig.modelsByRole.chat[0];
  }
  configCopy.selectedModelByRole.chat = chatModel;

  // summarize not implemented yet
  const roles: ModelRole[] = [
    "autocomplete",
    "apply",
    "edit",
    "embed",
    "rerank",
  ];

  for (const role of roles) {
    let newModel: ILLM | null = null;
    const currentSelection = currentForProfile[role] ?? null;

    // The UI only lets the user pick ONE model (the chat model), so that single
    // selection should drive the secondary roles (apply/edit) when it is capable
    // of them. Prefer the selected chat model over BOTH a stale persisted
    // per-role selection AND the arbitrary "first model declaring the role"
    // default. This keeps "pick one model → it does everything" intuitive
    // instead of silently routing edits to another model. A chat-only model (or
    // one not configured with the role) is skipped here, falling through to the
    // explicit per-role selection or the first declaring model.
    const chatDrives =
      (role === "apply" || role === "edit") &&
      !!chatModel &&
      continueConfig.modelsByRole[role].some(
        (m) => m.title === chatModel.title,
      );

    if (chatDrives) {
      newModel = chatModel;
    } else if (currentSelection) {
      // Explicit per-role selection still applies when the chat model does not
      // cover this role.
      const match = continueConfig.modelsByRole[role].find(
        (m) => m.title === currentSelection,
      );
      if (match) {
        newModel = match;
      }
    }

    if (!newModel && continueConfig.modelsByRole[role].length > 0) {
      newModel = continueConfig.modelsByRole[role][0];
    }

    if (!(currentSelection === (newModel?.title ?? null))) {
      fellBack = true;
    }

    // Currently only check for configuration status for apply
    if (
      role === "apply" &&
      newModel?.getConfigurationStatus() !== LLMConfigurationStatuses.VALID
    ) {
      continue;
    }

    configCopy.selectedModelByRole[role] = newModel;
  }

  // In the case shared config wasn't respected,
  // Rewrite the shared config
  if (fellBack) {
    globalContext.update("selectedModelsByProfileId", {
      ...currentSelectedModels,
      [profileId]: Object.fromEntries(
        Object.entries(configCopy.selectedModelByRole).map(([key, value]) => [
          key,
          value?.title ?? null,
        ]),
      ),
    });
  }

  return configCopy;
}
