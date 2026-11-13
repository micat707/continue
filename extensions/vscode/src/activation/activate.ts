import { getContinueRcPath, getTsConfigPath } from "core/util/paths";
import * as vscode from "vscode";

import { VsCodeExtension } from "../extension/VsCodeExtension";
import { isUnsupportedPlatform } from "../util/util";

import { GlobalContext } from "core/util/GlobalContext";
import { VsCodeContinueApi } from "./api";
import setupInlineTips from "./InlineTipManager";

export async function activateExtension(context: vscode.ExtensionContext) {
  const platformCheck = isUnsupportedPlatform();
  const globalContext = new GlobalContext();
  const hasShownUnsupportedPlatformWarning = globalContext.get(
    "hasShownUnsupportedPlatformWarning",
  );

  if (platformCheck.isUnsupported && !hasShownUnsupportedPlatformWarning) {
    const platformTarget = "windows-arm64";

    globalContext.update("hasShownUnsupportedPlatformWarning", true);
    void vscode.window.showInformationMessage(
      `Continue detected that you are using ${platformTarget}. Due to native dependencies, Continue may not be able to start`,
    );
  }

  // Add necessary files
  getTsConfigPath();
  getContinueRcPath();

  // Register commands and providers
  setupInlineTips(context);

  const vscodeExtension = new VsCodeExtension(context);

  // Load Continue configuration
  if (!context.globalState.get("hasBeenInstalled")) {
    void context.globalState.update("hasBeenInstalled", true);
  }

  // Register config.yaml schema. This requires the Red Hat YAML extension
  // ("redhat.vscode-yaml") to be installed, otherwise `yaml.schemas` is not a
  // registered configuration and the update throws. Only attempt it when present
  // so we don't log a scary (but harmless) error otherwise.
  const yamlExtension = vscode.extensions.getExtension("redhat.vscode-yaml");
  if (yamlExtension) {
    const yamlMatcher = ".continue/**/*.yaml";
    const yamlConfig = vscode.workspace.getConfiguration("yaml");
    const yamlSchemas = yamlConfig.get<object>("schemas", {});

    const newPath = vscode.Uri.joinPath(
      context.extension.extensionUri,
      "config-yaml-schema.json",
    ).toString();

    try {
      await yamlConfig.update(
        "schemas",
        {
          ...yamlSchemas,
          [newPath]: [yamlMatcher],
        },
        vscode.ConfigurationTarget.Global,
      );
    } catch (error) {
      console.error("Failed to register Continue config.yaml schema", error);
    }
  }

  const api = new VsCodeContinueApi(vscodeExtension);
  const continuePublicApi = {
    registerCustomContextProvider: api.registerCustomContextProvider.bind(api),
  };

  // MicatCode deep links: micat-spec://<name>, micat-steering://<name>, etc.
  // Open the corresponding Workspace feature page in the GUI with that item selected.
  const MICAT_DEEP_LINK_ROUTES: Record<string, string> = {
    spec: "specs",
    steering: "steering",
    hooks: "hooks",
    power: "power",
  };
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri(uri: vscode.Uri) {
        const schemeMatch = uri.scheme.match(/^micat-(.+)$/);
        if (!schemeMatch) {
          return;
        }
        const route = MICAT_DEEP_LINK_ROUTES[schemeMatch[1]];
        if (!route) {
          return;
        }
        const name = decodeURIComponent(uri.path.replace(/^\//, ""));
        void vscode.commands.executeCommand(
          "continue.navigateTo",
          `/${route}?name=${encodeURIComponent(name)}`,
          false,
        );
      },
    }),
  );

  // 'export' public api-surface
  // or entire extension for testing
  return process.env.NODE_ENV === "test"
    ? {
        ...continuePublicApi,
        extension: vscodeExtension,
      }
    : continuePublicApi;
}
