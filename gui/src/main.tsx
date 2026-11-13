import React from "react";
import ReactDOM from "react-dom/client";
import { Provider } from "react-redux";
import { PersistGate } from "redux-persist/integration/react";
import App from "./App";
import "./index.css";
// Kiro-style theme overrides (colors + message header + tabs).
import "./kiro-theme.css";
// VS Code codicon icon font (provides .codicon glyphs used across the UI,
// e.g. the Review-changes card icons).
import "@vscode/codicons/dist/codicon.css";
import codiconFontUrl from "@vscode/codicons/dist/codicon.ttf?inline";

// The published codicon.css points its @font-face at `./codicon.ttf?<hash>`.
// Inside a VS Code webview the resolved absolute URL (`/assets/codicon.ttf`)
// falls outside localResourceRoots, so it gets a 403 and every glyph renders as
// a tofu box. Inline the font as a data URI instead — no path, no permission
// issue. Later @font-face with the same family wins over the packaged one.
const codiconFontFace = document.createElement("style");
codiconFontFace.textContent = `@font-face { font-family: "codicon"; font-display: block; src: url("${codiconFontUrl}") format("truetype"); }`;
document.head.appendChild(codiconFontFace);
import { persistor, store } from "./redux/store";

(async () => {
  const container = document.getElementById("root") as HTMLElement;

  // Create React root
  const root = ReactDOM.createRoot(container);

  root.render(
    <React.StrictMode>
      <Provider store={store}>
        <PersistGate loading={null} persistor={persistor}>
          <App />
        </PersistGate>
      </Provider>
    </React.StrictMode>,
  );
})();
