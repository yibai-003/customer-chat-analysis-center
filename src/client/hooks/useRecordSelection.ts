import { useCallback, useEffect, useState } from "react";

export function useRecordSelection(scope: {
  jobId?: string;
  sectionId?: string;
  filter: string;
}) {
  const { jobId, sectionId, filter } = scope;
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  useEffect(() => {
    setSelectedIds([]);
  }, [jobId, sectionId, filter]);

  const toggle = useCallback((id: string) => setSelectedIds((current) => (
    current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
  )), []);

  const togglePage = useCallback((ids: string[]) => setSelectedIds((current) => {
    const allSelected = ids.length > 0 && ids.every((id) => current.includes(id));
    return allSelected ? current.filter((id) => !ids.includes(id)) : [...new Set([...current, ...ids])];
  }), []);

  const clear = useCallback(() => setSelectedIds([]), []);

  return {
    selectedIds,
    toggle,
    togglePage,
    clear,
  };
}
