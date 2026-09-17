export type RecordStatus = "pending" | "processing" | "completed" | "failed" | "needs_review";
export type ReviewStatus = "pending" | "confirmed" | "needs_review";
export type JobStatus = "ready" | "processing" | "paused" | "completed" | "failed" | "cancelled";
export type ImportJobStatus = "queued" | "processing" | "completed" | "failed" | "cancelled";

export interface ImportJob {
  id: string;
  filename: string;
  sourcePath: string;
  jobId: string | null;
  sectionId: string | null;
  sectionName: string | null;
  status: ImportJobStatus;
  totalImages: number;
  processedImages: number;
  failedImages: number;
  totalRecords: number;
  processedRecords: number;
  currentSheet: string | null;
  currentRow: number | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RecordSummary {
  id: string;
  rowNumber: number;
  sheetName: string;
  sourceFields: Record<string, string>;
  imageUrl: string;
  status: RecordStatus;
  reviewStatus: ReviewStatus;
}

export interface RecordPageQuery {
  page?: number;
  pageSize?: number;
  status?: string;
}

export interface RecordPage {
  items: RecordSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export interface Job {
  pendingRecords?: number;
  processingRecords?: number;
  needsReviewRecords?: number;
  needsReviewFields?: number;
  id: string;
  originalFilename: string;
  sectionId: string | null;
  sectionName: string | null;
  status: JobStatus;
  totalRecords: number;
  completedRecords: number;
  failedRecords: number;
  totalFields: number;
  completedFields: number;
  failedFields: number;
  skippedFields: number;
  createdAt: string;
  cancelRequested?: boolean;
}

export interface WorkbookPreview {
  originalFilename: string;
  sheetCount: number;
  imageCount: number;
  sectionId?: string;
  sectionName?: string;
  missingHeaders: string[];
  sheets: Array<{
    name: string;
    headers: string[];
    imageCount: number;
    imageRows: number[];
  }>;
}

export interface AnalysisSection {
  id: string;
  parentId: string | null;
  name: string;
  prompt: string;
  outputSchema: OutputField[];
  sortOrder: number;
  isEnabled: boolean;
  imageEnabled?: boolean;
  sourceFields?: string[];
}

export interface OutputField {
  key: string;
  label: string;
  type: "string" | "number" | "boolean" | "object";
  required?: boolean;
  options?: string[];
}

export type AnalysisFieldType = OutputField["type"];
export type AnalysisExecutionType =
  | "ai"
  | "knowledge_match"
  | "knowledge_extract"
  | "lost_deal_attribution"
  | "lost_deal_derive"
  | "lost_deal_script"
  | "reception_quality_analysis"
  | "reception_quality_derive";

export type KnowledgeColumnRole =
  | "result"
  | "search"
  | "keyword"
  | "description"
  | "positive_example"
  | "negative_example"
  | "metadata";

export interface KnowledgeColumn {
  name: string;
  roles: KnowledgeColumnRole[];
  requiredParent?: string;
}

export interface KnowledgeBase {
  id: string;
  sectionId: string;
  name: string;
  originalFilename: string;
  columns: KnowledgeColumn[];
  itemCount: number;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeItem {
  id: string;
  knowledgeBaseId: string;
  values: Record<string, string>;
  isEnabled: boolean;
  sourceRowNumber?: number;
  updatedAt: string;
  /** 当前关联的不同对话记录数，重新解析同一记录不重复计数。 */
  occurrenceCount?: number;
}

export interface KnowledgeImportPreview {
  token: string;
  headers: string[];
  totalRows: number;
  added: number;
  updated: number;
  skipped: number;
  duplicateRows: number;
  errors: Array<{ rowNumber: number; message: string }>;
}

export interface KnowledgeImportResult {
  knowledgeBase: KnowledgeBase;
  added: number;
  updated: number;
  skipped: number;
}

export interface KnowledgeItemQuery {
  search?: string;
  enabled?: boolean;
  page?: number;
  pageSize?: number;
}

export interface KnowledgeItemPage {
  items: KnowledgeItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface KnowledgeCandidate {
  itemId: string;
  values: Record<string, string>;
  score: number;
  matchedText: string;
}

export interface KnowledgeMatchResult {
  status: "completed" | "needs_review";
  result: Record<string, string>;
  snapshotId?: string;
  errorMessage?: string;
}

export type KnowledgeBaseInput = Omit<
  KnowledgeBase,
  "id" | "itemCount" | "createdAt" | "updatedAt"
> & { id?: string };

export type KnowledgeItemInput = Omit<KnowledgeItem, "id" | "updatedAt"> & { id?: string };

export interface AnalysisField {
  id: string;
  sectionId: string;
  key: string;
  label: string;
  type: AnalysisFieldType;
  prompt: string;
  required: boolean;
  imageEnabled: boolean;
  dependsOn: string[];
  sortOrder: number;
  isEnabled: boolean;
  options?: string[];
  outputColumn?: string;
  executionType?: AnalysisExecutionType;
  exportEnabled?: boolean;
  knowledgeBaseId?: string;
  candidateLimit?: number;
  matchFieldKey?: string;
  knowledgeColumn?: string;
  /** AI 字段产出后，是否将结果沉淀到所属板块知识库。 */
  knowledgeSyncEnabled?: boolean;
  /** 单次分析最多新增的热点问题词条数。 */
  knowledgeCaptureLimit?: 1 | 2;
}

export type AnalysisFieldInput = Partial<AnalysisField> & {
  sectionId: string;
  key: string;
  label: string;
  type: AnalysisFieldType;
  prompt?: string;
};

export interface AnalysisFieldRun {
  id: string;
  recordId: string;
  fieldId: string;
  sectionId: string;
  fieldKey: string;
  status: "completed" | "failed" | "needs_review" | "skipped";
  result: Record<string, unknown>;
  evidence?: string;
  dependencies: Record<string, unknown>;
  promptSnapshot?: string;
  fieldSnapshot?: AnalysisField;
  modelConfigSnapshot?: unknown;
  rawResponse?: string;
  errorMessage?: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  createdAt: string;
}

export interface ModelConfig {
  id: string;
  name: string;
  baseUrl: string;
  maskedApiKey: string;
  model: string;
  supportsVision: boolean;
  temperature: number;
  maxTokens: number;
  isDefault: boolean;
  purpose: "vision" | "text";
  isPurposeDefault: boolean;
  isEnabled: boolean;
  capabilityStatus?: { text: boolean; json: boolean; vision: boolean; errors?: Partial<Record<"text" | "json" | "vision", string>> };
  capabilityCheckedAt?: string;
}

export interface AnalysisRun {
  id: string;
  recordId: string;
  sectionId: string;
  status: "completed" | "failed" | "needs_review";
  result: Record<string, unknown>;
  rawResponse?: string;
  errorMessage?: string;
  createdAt: string;
}

export interface RecordDetail extends RecordSummary {
  jobId: string;
  imagePath: string;
  humanResult: Record<string, unknown> | null;
  reviewNote: string;
  sectionReviews?: Record<string, {
    humanResult: Record<string, unknown> | null;
    reviewStatus: ReviewStatus;
    reviewNote: string;
  }>;
  analysisRuns: AnalysisRun[];
  fieldRuns: AnalysisFieldRun[];
}

export interface BatchProgress {
  total: number;
  completed: number;
  failed: number;
  needsReview: number;
}

export interface AnalysisJobOptions {
  concurrency?: number;
  batchSize?: number;
  recordIds?: string[];
}

export interface AnalysisCapacityMetrics {
  logicalProcessors: number;
  totalMemoryGb: number;
  freeMemoryGb: number;
  diskFreeGb: number | null;
  activeJobs: number;
}

export interface AnalysisRecommendation {
  concurrency: number;
  batchSize: number;
}

export interface AnalysisCapacity {
  metrics: AnalysisCapacityMetrics;
  recommendation: AnalysisRecommendation;
  allowedRanges: {
    concurrency: { min: number; max: number };
    batchSize: { min: number; max: number };
  };
  warnings: string[];
}
