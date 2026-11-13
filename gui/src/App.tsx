import { RouterProvider, createMemoryRouter } from "react-router-dom";
import Layout from "./components/Layout";
import { MainEditorProvider } from "./components/mainInput/TipTapEditor";
import { SubmenuContextProvidersProvider } from "./context/SubmenuContextProviders";
import { VscThemeProvider } from "./context/VscTheme";
import ParallelListeners from "./hooks/ParallelListeners";
import ConfigPage from "./pages/config";
import ErrorPage from "./pages/error";
import Chat from "./pages/gui";
import History from "./pages/history";
import Stats from "./pages/stats";
import Steering from "./pages/Steering";
import Specs from "./pages/Specs";
import Hooks from "./pages/Hooks";
import Power from "./pages/Power";
import ThemePage from "./styles/ThemePage";
import { ROUTES } from "./util/navigation";

// The extension injects `window.initialRoute` into the webview HTML
// (see ContinueGUIWebviewViewProvider.getSidebarContent) so the full-screen
// GUI can boot directly on a route like "/config?tab=permissions".
const initialRoute = (window as any).initialRoute as string | undefined;

const router = createMemoryRouter(
  [
    {
      path: ROUTES.HOME,
      element: <Layout />,
      errorElement: <ErrorPage />,
      children: [
        {
          path: "/index.html",
          element: <Chat />,
        },
        {
          path: ROUTES.HOME,
          element: <Chat />,
        },
        {
          path: "/history",
          element: <History />,
        },
        {
          path: ROUTES.STATS,
          element: <Stats />,
        },
        {
          path: ROUTES.CONFIG,
          element: <ConfigPage />,
        },
        {
          path: ROUTES.THEME,
          element: <ThemePage />,
        },
        {
          path: ROUTES.STEERING,
          element: <Steering />,
        },
        {
          path: ROUTES.SPECS,
          element: <Specs />,
        },
        {
          path: ROUTES.HOOKS,
          element: <Hooks />,
        },
        {
          path: ROUTES.POWER,
          element: <Power />,
        },
      ],
    },
    // Boot the router on the extension-injected initial route (see
    // ContinueGUIWebviewViewProvider.getSidebarContent) instead of "/".
  ],
  {
    initialEntries: [
      initialRoute && initialRoute.startsWith("/") ? initialRoute : "/",
    ],
  },
);

// When the extension reuses an already-open full-screen panel (instead of
// reloading it), it posts a targeted navigation so we jump without a reload.
if (typeof window !== "undefined") {
  window.addEventListener("message", (e: MessageEvent) => {
    const data = e.data as { type?: string; page?: string } | undefined;
    if (
      data &&
      data.type === "deepAgent/navigate" &&
      typeof data.page === "string" &&
      data.page.startsWith("/")
    ) {
      router.navigate(data.page);
    }
  });
}

/*
  ParallelListeners prevents entire app from rerendering on any change in the listeners,
  most of which interact with redux etc.
*/
function App() {
  return (
    <VscThemeProvider>
      <MainEditorProvider>
        <SubmenuContextProvidersProvider>
          <RouterProvider router={router} />
        </SubmenuContextProvidersProvider>
      </MainEditorProvider>
      <ParallelListeners />
    </VscThemeProvider>
  );
}

export default App;
