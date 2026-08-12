import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./index.css";
import { App } from "./App";
import { installPreloadErrorRecovery } from "./lib/preload-error-recovery";
import { ProjectProvider } from "./lib/project-context";
import { AuthGate } from "./AuthGate";

installPreloadErrorRecovery(window);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        {/*
          AuthGate wraps ProjectProvider rather than sitting inside App: on the
          gated deployment every data query would 401, so nothing below this
          point should mount until a session exists. On a local daemon the gate
          detects that no auth routes are mounted and renders straight through.
        */}
        <AuthGate>
          <ProjectProvider>
            <App />
          </ProjectProvider>
        </AuthGate>
      </QueryClientProvider>
    </BrowserRouter>
  </StrictMode>
);
