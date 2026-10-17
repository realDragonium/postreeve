import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
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
        <App />
      </ErrorBoundary>
    </QueryClientProvider>
  </StrictMode>,
);

registerServiceWorker();
