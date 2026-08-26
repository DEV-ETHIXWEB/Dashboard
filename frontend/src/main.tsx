import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./index.css";
import App from "./App.tsx";
import { AuthProvider } from "@/context/AuthContext";
import { LiveProvider } from "@/context/LiveContext";
import { registerServiceWorker } from "@/lib/pwa";
import { DEFAULT_GC_TIME, refetchIntervalFor, staleTimeFor } from "@/lib/queryCache";
import { persistQueryCache, restoreQueryCache } from "@/lib/queryPersist";

/**
 * Every read in the app takes its cache settings from `queryCache.ts` unless a
 * hook says otherwise, so how current a screen is stays one decision in one
 * file rather than a habit each hook picked up separately.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
      // Coming back to a screen should show what it showed before, immediately.
      // The stream corrects it if anything moved in the meantime.
      gcTime: DEFAULT_GC_TIME,
      staleTime: (query) => staleTimeFor(query.queryKey),
      refetchInterval: (query) => refetchIntervalFor(query.queryKey),
    },
  },
});

restoreQueryCache(queryClient);
persistQueryCache(queryClient);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <LiveProvider>
            <App />
          </LiveProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);

registerServiceWorker();
