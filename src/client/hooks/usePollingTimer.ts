import { useEffect, useRef } from "react";

export function usePollingTimer(enabled: boolean, callback: () => void, intervalMs = 2000) {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  useEffect(() => {
    if (!enabled) return undefined;
    const timer = setInterval(() => callbackRef.current(), intervalMs);
    return () => clearInterval(timer);
  }, [enabled, intervalMs]);
}
