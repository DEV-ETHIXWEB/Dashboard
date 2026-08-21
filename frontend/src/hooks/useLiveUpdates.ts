import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiUrl } from "@/lib/api";
import { isLiveTopic, keysForTopic, type LiveStatus, type LiveTopic } from "@/lib/live";

/** Bursts of writes on the admin side collapse into one refetch. */
const COALESCE_MS = 250;

/** How many failed streams before we stop trying and just poll. */
const MAX_STREAM_FAILURES = 4;

/** Polling cadence once the stream is written off (hosts that buffer SSE). */
const POLL_MS = 30_000;

/**
 * Keeps this tab in step with everyone else's.
 *
 * The stream is an optimisation, not a source of truth: if it never connects --
 * a serverless host, a proxy that buffers, a corporate network -- the tab falls
 * back to polling and to refetching whenever it regains focus, and every screen
 * still shows current data. Nothing is read from the event itself.
 */
export function useLiveUpdates(enabled: boolean, onSessionChange?: () => void) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<LiveStatus>("connecting");

  const pending = useRef<Set<LiveTopic>>(new Set());
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionHandler = useRef(onSessionChange);
  sessionHandler.current = onSessionChange;

  const flush = useCallback(() => {
    flushTimer.current = null;
    const topics = [...pending.current];
    pending.current.clear();

    const seen = new Set<string>();
    for (const topic of topics) {
      if (topic === "session") {
        sessionHandler.current?.();
        continue;
      }
      for (const key of keysForTopic(topic)) {
        const id = key.join("/");
        if (seen.has(id)) continue;
        seen.add(id);
        queryClient.invalidateQueries({ queryKey: key });
      }
    }
  }, [queryClient]);

  const queue = useCallback(
    (topic: LiveTopic) => {
      pending.current.add(topic);
      if (flushTimer.current == null) flushTimer.current = setTimeout(flush, COALESCE_MS);
    },
    [flush],
  );

  /** Everything on screen is suspect after a gap in the connection. */
  const refetchEverything = useCallback(() => {
    queryClient.invalidateQueries({ type: "active" });
  }, [queryClient]);

  useEffect(() => {
    if (!enabled) return;
    if (typeof window === "undefined" || typeof EventSource === "undefined") {
      setStatus("polling");
      return;
    }

    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let failures = 0;
    let stopped = false;

    const startPolling = () => {
      if (pollTimer != null) return;
      setStatus(navigator.onLine ? "polling" : "offline");
      pollTimer = setInterval(() => {
        if (document.visibilityState === "visible" && navigator.onLine) refetchEverything();
      }, POLL_MS);
    };

    const connect = () => {
      if (stopped) return;
      source?.close();
      setStatus((prev) => (prev === "live" ? "live" : "connecting"));

      const es = new EventSource(apiUrl("/events"), { withCredentials: true });
      source = es;

      es.addEventListener("ready", () => {
        failures = 0;
        if (pollTimer != null) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
        setStatus("live");
        // The tab may have missed changes while it was cut off.
        refetchEverything();
      });

      es.addEventListener("change", (event) => {
        try {
          const data = JSON.parse((event as MessageEvent).data) as { topic?: unknown };
          if (isLiveTopic(data.topic)) queue(data.topic);
        } catch {
          // A malformed frame is not worth tearing the stream down for.
        }
      });

      es.onerror = () => {
        es.close();
        if (stopped) return;
        failures += 1;

        if (!navigator.onLine) {
          setStatus("offline");
          return; // the online listener reconnects
        }
        if (failures >= MAX_STREAM_FAILURES) {
          startPolling();
          return;
        }
        setStatus("connecting");
        const backoff = Math.min(1000 * 2 ** (failures - 1), 15_000);
        retryTimer = setTimeout(connect, backoff);
      };
    };

    const onOnline = () => {
      failures = 0;
      refetchEverything();
      connect();
    };
    const onOffline = () => setStatus("offline");
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      refetchEverything();
      // Phones close sockets in the background; a closed stream needs a nudge.
      if (source == null || source.readyState === EventSource.CLOSED) connect();
    };

    connect();
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      stopped = true;
      source?.close();
      if (retryTimer != null) clearTimeout(retryTimer);
      if (pollTimer != null) clearInterval(pollTimer);
      if (flushTimer.current != null) clearTimeout(flushTimer.current);
      flushTimer.current = null;
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, queue, refetchEverything]);

  return { status, refetchEverything };
}
