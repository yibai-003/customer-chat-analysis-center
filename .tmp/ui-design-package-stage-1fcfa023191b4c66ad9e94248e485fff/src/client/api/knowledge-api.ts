import type {
  KnowledgeBase,
  KnowledgeCandidate,
  KnowledgeColumn,
  KnowledgeImportPreview,
  KnowledgeImportResult,
  KnowledgeItem,
  KnowledgeItemPage,
  KnowledgeItemQuery,
} from "../../shared/types";

interface ApiEnvelope<T> {
  success: boolean;
  data: T;
  error: string | null;
}

export interface KnowledgeImportPreviewResponse extends KnowledgeImportPreview {
  resolvedKnowledgeBaseId?: string | null;
}

export interface KnowledgeItemMutation {
  values?: Record<string, string>;
  isEnabled?: boolean;
}

export interface KnowledgeApiClient {
  listBases(sectionId: string): Promise<KnowledgeBase[]>;
  previewImport(
    sectionId: string,
    file: File,
    columns?: KnowledgeColumn[],
    knowledgeBaseId?: string,
  ): Promise<KnowledgeImportPreviewResponse>;
  confirmImport(
    sectionId: string,
    token: string,
    columns: KnowledgeColumn[],
    name?: string,
    knowledgeBaseId?: string,
  ): Promise<KnowledgeImportResult>;
  updateBase(id: string, patch: Pick<Partial<KnowledgeBase>, "name" | "isEnabled">): Promise<KnowledgeBase>;
  deleteBase(id: string): Promise<boolean>;
  listItems(baseId: string, query: KnowledgeItemQuery): Promise<KnowledgeItemPage>;
  createItem(baseId: string, input: KnowledgeItemMutation): Promise<KnowledgeItem>;
  updateItem(id: string, input: KnowledgeItemMutation): Promise<KnowledgeItem>;
  deleteItem(id: string): Promise<boolean>;
  search(baseId: string, query: string, limit?: number): Promise<KnowledgeCandidate[]>;
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => null) as ApiEnvelope<T> | null;
  if (!response.ok || !body?.success) {
    throw new Error(body?.error || "请求失败");
  }
  return body.data;
}

function jsonOptions(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

export const knowledgeApi: KnowledgeApiClient = {
  listBases: (sectionId) => request(`/api/sections/${sectionId}/knowledge-bases`),
  previewImport: (sectionId, file, columns, knowledgeBaseId) => {
    const form = new FormData();
    form.append("file", file);
    if (columns) form.append("columns", JSON.stringify(columns));
    if (knowledgeBaseId) form.append("knowledgeBaseId", knowledgeBaseId);
    return request(`/api/sections/${sectionId}/knowledge-bases/import-preview`, {
      method: "POST",
      body: form,
    });
  },
  confirmImport: (sectionId, token, columns, name, knowledgeBaseId) => request(
    `/api/sections/${sectionId}/knowledge-bases/import`,
    jsonOptions("POST", { token, columns, name, knowledgeBaseId }),
  ),
  updateBase: (id, patch) => request(`/api/knowledge-bases/${id}`, jsonOptions("PATCH", patch)),
  deleteBase: (id) => request(`/api/knowledge-bases/${id}`, { method: "DELETE" }),
  listItems: (baseId, query) => {
    const params = new URLSearchParams();
    if (query.search) params.set("search", query.search);
    if (query.enabled !== undefined) params.set("enabled", String(query.enabled));
    if (query.page) params.set("page", String(query.page));
    if (query.pageSize) params.set("pageSize", String(query.pageSize));
    const suffix = params.size ? `?${params}` : "";
    return request(`/api/knowledge-bases/${baseId}/items${suffix}`);
  },
  createItem: (baseId, input) => request(
    `/api/knowledge-bases/${baseId}/items`,
    jsonOptions("POST", input),
  ),
  updateItem: (id, input) => request(`/api/knowledge-items/${id}`, jsonOptions("PATCH", input)),
  deleteItem: (id) => request(`/api/knowledge-items/${id}`, { method: "DELETE" }),
  search: (baseId, query, limit = 10) => request(
    `/api/knowledge-bases/${baseId}/search-test`,
    jsonOptions("POST", { query, limit }),
  ),
};
