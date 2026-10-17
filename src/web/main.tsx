import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { AuthGate } from "./AuthGate";
import { ErrorBoundary } from "./ErrorBoundary";
// Bundled rather than loaded from Google Fonts: the CSP allows only same-origin styles and fonts, the installed app
// works offline, and opening Postreeve makes no third-party request.
// Bundled rather than loaded from Google Fonts: the CSP allows only same-origin styles and fonts, the installed app
// works offline, and opening Postreeve makes no third-party request.
import "@fontsource/instrument-sans/400.css";
import "@fontsource/instrument-sans/500.css";
import "@fontsource/instrument-sans/600.css";
import "@fontsource/instrument-sans/700.css";
import "./styles.css";
import { registerServiceWorker } from "./pwa";

if (window.location.protocol === "postreeve:") {
  document.documentElement.dataset.desktop = "true";
  document.documentElement.dataset.desktopPlatform = navigator.userAgent.includes("Macintosh")
    ? "macos"
    : "other";
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const root = document.getElementById("root");
if (!root) throw new Error("Postreeve root element is missing");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ErrorBoundary label="app">
        <AuthGate>
          <App />
        </AuthGate>
      </ErrorBoundary>
    </QueryClientProvider>
  </StrictMode>,
);

registerServiceWorker();
