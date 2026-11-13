import * as vscode from "vscode";
import { getFullScreenTab, fullScreenPanel } from "./commands.js";

/**
 * Toggle the chat panel:
 * - If it is open in a full-screen editor tab, close that tab.
 * - Otherwise toggle the secondary (auxiliary) sidebar, where the
 *   continue.continueGUIView webview lives.
 *
 * Kept in its own module so the only edits to commands.ts are a small
 * wiring import plus exporting the two helpers used below.
 */
export function toggleGUI() {
  const fullScreenTab = getFullScreenTab();
  if (fullScreenTab) {
    fullScreenPanel?.dispose();
  } else {
    vscode.commands.executeCommand("workbench.action.toggleAuxiliaryBar");
  }
}
