import { useEffect, useRef } from "react";

export function usePollingTimer(enabled: boolean, callback: () => void | Promise<void>, intervalMs = 2000) {
  const callbackRef = useRef(callback);
  const runningRef = useRef(false);
  callbackRef.current = callback;
  useEffect(() => {
    if (!enabled) return undefined;
    const timer = setInterval(() => {
      if (runningRef.current) return;
      runningRef.current = true;
      Promise.resolve(callbackRef.current()).finally(() => { runningRef.current = false; });
    }, intervalMs);
    return () => clearInterval(timer);
  }, [enabled, intervalMs]);
}
