import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./index.css";
import { App } from "./App";
import { installPreloadErrorRecovery } from "./lib/preload-error-recovery";
import { ProjectProvider } from "./lib/project-context";
import { AuthGate } from "./AuthGate";
import { SharedConversationPage } from "./pages/SharedConversationPage";

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
          The share page is split off ABOVE the gate and above the app shell
          (mt#4024), not routed inside them.

          Being public is the whole feature — a link handed to someone with no
          account — so it must not mount `AuthGate` (a sign-in screen over the
          one page meant to be readable without signing in), and it must not
          mount `App` (cockpit navigation the reader cannot use, plus SSE and
          widget polling that would 401 on every tick). Splitting the tree here
          makes both true by construction rather than by a path check inside
          each of them.

          Everything else keeps the previous shape: AuthGate wraps
          ProjectProvider rather than sitting inside App, because on the gated
          deployment every data query would 401, so nothing below that point
          should mount until a session exists. On a local daemon the gate
          detects that no auth routes are mounted and renders straight through.
        */}
        <Routes>
          <Route path="/s/:token" element={<SharedConversationPage />} />
          <Route
            path="*"
            element={
              <AuthGate>
                <ProjectProvider>
                  <App />
                </ProjectProvider>
              </AuthGate>
            }
          />
        </Routes>
      </QueryClientProvider>
    </BrowserRouter>
  </StrictMode>
);
