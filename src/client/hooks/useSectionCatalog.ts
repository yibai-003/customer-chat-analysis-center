import { useEffect, useState } from "react";
import type { AnalysisField, AnalysisSection } from "../../shared/types";
import { api } from "../api";

export function useSectionCatalog({ sections, setNotice }: {
  sections: AnalysisSection[];
  setNotice: (message: string) => void;
}) {
  const [activeSection, setActiveSection] = useState("reception");
  const [activeFields, setActiveFields] = useState<AnalysisField[]>([]);
  const childSections = sections.filter((section) => section.parentId);
  const currentSection = sections.find((section) => section.id === activeSection) ?? childSections[0];
  const currentSectionId = currentSection?.id;

  useEffect(() => {
    if (!currentSectionId) return;
    const request = new AbortController();
    setActiveFields([]);
    api<AnalysisField[]>(`/api/sections/${currentSectionId}/fields`, { signal: request.signal })
      .then(fields => { if (!request.signal.aborted) setActiveFields(fields); })
      .catch(error => { if (!request.signal.aborted) setNotice(error.message); });
    return () => request.abort();
  }, [currentSectionId, setNotice]);

  return { activeSection, setActiveSection, activeFields, currentSection, childSections };
}
