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

  useEffect(() => {
    if (!currentSection) return;
    const request = new AbortController();
    setActiveFields([]);
    api<AnalysisField[]>(`/api/sections/${currentSection.id}/fields`, { signal: request.signal })
      .then(fields => { if (!request.signal.aborted) setActiveFields(fields); })
      .catch(error => { if (!request.signal.aborted) setNotice(error.message); });
    return () => request.abort();
  }, [currentSection?.id]);

  return { activeSection, setActiveSection, activeFields, currentSection, childSections };
}
