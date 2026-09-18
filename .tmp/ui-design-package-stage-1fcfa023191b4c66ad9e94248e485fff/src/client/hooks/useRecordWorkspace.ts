import { useEffect, useRef, useState } from "react";
import type { RecordDetail, RecordPage } from "../../shared/types";
import { api } from "../api";

const DEFAULT_PAGE_SIZE = 50;
export const EMPTY_RECORD_PAGE: RecordPage = {
  items: [],
  total: 0,
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
};

export interface RecordQueryIdentity {
  jobId: string | null;
  page: number;
  pageSize: number;
  filter: string;
}

export const EMPTY_RECORD_QUERY: RecordQueryIdentity = {
  jobId: null,
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
  filter: "all",
};

export function useRecordWorkspace(setNotice: (message: string) => void) {
  const [recordPage, setRecordPage] = useState<RecordPage>(EMPTY_RECORD_PAGE);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [selected, setSelected] = useState<RecordDetail | null>(null);
  const [filter, setFilter] = useState("all");
  const listRequestIdRef = useRef(0);
  const intendedRecordQueryRef = useRef<RecordQueryIdentity>(EMPTY_RECORD_QUERY);
  const committedRecordQueryRef = useRef<RecordQueryIdentity>(EMPTY_RECORD_QUERY);
  const recordPageRef = useRef<RecordPage>(EMPTY_RECORD_PAGE);
  const detailRequestIdRef = useRef(0);
  const selectedRef = useRef<RecordDetail | null>(null);
  const detailRevisionRef = useRef(0);
  const detailDirtyRef = useRef(false);
  const listAbortRef = useRef<AbortController | null>(null);
  const detailAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => {
    listRequestIdRef.current++; detailRequestIdRef.current++;
    listAbortRef.current?.abort(); detailAbortRef.current?.abort();
  }, []);
  const setSelectedRecord = (nextSelected: RecordDetail | null) => {
    selectedRef.current = nextSelected;
    if (!nextSelected) detailDirtyRef.current = false;
    setSelected(nextSelected);
  };

  const clearSelectedRecord = () => {
    detailAbortRef.current?.abort();
    detailRequestIdRef.current += 1;
    detailRevisionRef.current += 1;
    detailDirtyRef.current = false;
    setSelectedRecord(null);
  };

  const editSelectedRecord = (nextSelected: RecordDetail) => {
    detailAbortRef.current?.abort();
    detailRequestIdRef.current += 1;
    detailRevisionRef.current += 1;
    detailDirtyRef.current = true;
    selectedRef.current = nextSelected;
    setSelected(nextSelected);
  };

  const fetchRecordPage = (query: RecordQueryIdentity) => {
    if (!query.jobId) throw new Error("记录任务不存在");
    const params = new URLSearchParams({
      page: String(query.page),
      pageSize: String(query.pageSize),
    });
    if (query.filter !== "all") params.set("status", query.filter);
    return api<RecordPage>(`/api/jobs/${query.jobId}/records?${params}`, { signal: listAbortRef.current?.signal });
  };

  const isLatestListRequest = (requestId: number, query: RecordQueryIdentity) => (
    listRequestIdRef.current === requestId
    && intendedRecordQueryRef.current === query
  );

  const beginListRequest = (query: RecordQueryIdentity) => {
    listAbortRef.current?.abort(); detailAbortRef.current?.abort();
    listAbortRef.current = new AbortController();
    const requestId = ++listRequestIdRef.current;
    intendedRecordQueryRef.current = query;
    detailRequestIdRef.current += 1;
    return requestId;
  };

  const loadValidRecordPage = async (
    initialQuery: RecordQueryIdentity,
    requestId: number,
  ): Promise<{ query: RecordQueryIdentity; recordPage: RecordPage } | null> => {
    let query = initialQuery;
    while (true) {
      const nextRecordPage = await fetchRecordPage(query);
      if (!isLatestListRequest(requestId, query)) return null;
      const lastPage = Math.max(1, Math.ceil(nextRecordPage.total / query.pageSize));
      if (nextRecordPage.total === 0) {
        if (query.page !== 1) {
          query = { ...query, page: 1 };
          intendedRecordQueryRef.current = query;
        }
        return {
          query,
          recordPage: { ...nextRecordPage, page: 1, pageSize: query.pageSize },
        };
      }
      if (query.page <= lastPage) {
        return {
          query,
          recordPage: { ...nextRecordPage, page: query.page, pageSize: query.pageSize },
        };
      }
      query = { ...query, page: lastPage };
      intendedRecordQueryRef.current = query;
    }
  };

  const commitRecordPage = (query: RecordQueryIdentity, nextRecordPage: RecordPage) => {
    intendedRecordQueryRef.current = query;
    committedRecordQueryRef.current = query;
    recordPageRef.current = nextRecordPage;
    setRecordPage(nextRecordPage);
    setPage(query.page);
    setPageSize(query.pageSize);
    setFilter(query.filter);
    const currentSelected = selectedRef.current;
    if (
      currentSelected
      && (
        currentSelected.jobId !== query.jobId
        || !nextRecordPage.items.some((item) => item.id === currentSelected.id)
      )
    ) {
      clearSelectedRecord();
    }
  };

  const rollbackLatestListRequest = (
    requestId: number,
    query: RecordQueryIdentity,
    error: unknown,
    fallbackMessage: string,
  ) => {
    if (!isLatestListRequest(requestId, query)) return;
    const committedQuery = committedRecordQueryRef.current;
    intendedRecordQueryRef.current = committedQuery;
    setPage(committedQuery.page);
    setPageSize(committedQuery.pageSize);
    setFilter(committedQuery.filter);
    setNotice(error instanceof Error ? error.message : fallbackMessage);
  };

  const requestRecordDetail = async (
    recordId: string,
    jobId: string,
    options: { explicit?: boolean; remainsCurrent?: () => boolean } = {},
  ) => {
    if (!options.explicit && detailDirtyRef.current && selectedRef.current?.id === recordId) {
      return false;
    }
    if (options.explicit) {
      detailRevisionRef.current += 1;
      detailDirtyRef.current = false;
    }
    const requestId = ++detailRequestIdRef.current;
    detailAbortRef.current?.abort();
    const request = new AbortController(); detailAbortRef.current = request;
    const detailRevision = detailRevisionRef.current;
    const listRequestId = listRequestIdRef.current;
    const query = intendedRecordQueryRef.current;
    try {
      const nextDetail = await api<RecordDetail>(`/api/records/${recordId}`, { signal: request.signal });
      const remainsCurrent = (
        detailRequestIdRef.current === requestId
        && detailRevisionRef.current === detailRevision
        && !detailDirtyRef.current
        && listRequestIdRef.current === listRequestId
        && intendedRecordQueryRef.current === query
        && query.jobId === jobId
        && nextDetail.jobId === jobId
        && recordPageRef.current.items.some((item) => item.id === recordId)
        && (options.remainsCurrent?.() ?? true)
      );
      if (remainsCurrent) setSelectedRecord(nextDetail);
      return remainsCurrent;
    } catch (error) {
      if (
        detailRequestIdRef.current === requestId
        && (options.remainsCurrent?.() ?? true)
      ) {
        setNotice(error instanceof Error ? error.message : "记录详情加载失败");
      }
      return false;
    }
  };

  const requestPage = async (
    query: RecordQueryIdentity,
    fallbackMessage: string,
    remainsCurrent: () => boolean = () => true,
  ) => {
    const requestId = beginListRequest(query);
    try {
      const result = await loadValidRecordPage(query, requestId);
      if (!result || !remainsCurrent()) return false;
      commitRecordPage(result.query, result.recordPage);
      return true;
    } catch (error) {
      if (remainsCurrent()) {
        rollbackLatestListRequest(requestId, intendedRecordQueryRef.current, error, fallbackMessage);
      }
      return false;
    }
  };

  const changeRecordPage = async (nextPage: number) => {
    const committedQuery = committedRecordQueryRef.current;
    if (!committedQuery.jobId) return;
    setPage(nextPage);
    await requestPage({ ...committedQuery, page: nextPage }, "记录分页加载失败");
  };

  const changePageSize = async (nextPageSize: number) => {
    const committedQuery = committedRecordQueryRef.current;
    if (!committedQuery.jobId) return;
    setPage(1);
    setPageSize(nextPageSize);
    await requestPage(
      { ...committedQuery, page: 1, pageSize: nextPageSize },
      "记录分页加载失败",
    );
  };

  const changeFilter = async (nextFilter: string) => {
    const committedQuery = committedRecordQueryRef.current;
    setFilter(nextFilter);
    setPage(1);
    if (!committedQuery.jobId) return;
    await requestPage(
      { ...committedQuery, page: 1, filter: nextFilter },
      "记录筛选失败",
    );
  };

  const refreshCurrentRecordPage = async (
    jobId: string,
    remainsCurrent: () => boolean,
  ) => {
    if (!remainsCurrent()) return false;
    const query = intendedRecordQueryRef.current;
    if (!query.jobId || query.jobId !== jobId) return false;
    const refreshed = await requestPage(
      { ...query },
      "解析进度刷新失败",
      remainsCurrent,
    );
    if (!refreshed || !remainsCurrent()) return false;
    const currentSelected = selectedRef.current;
    if (
      currentSelected
      && recordPageRef.current.items.some((item) => item.id === currentSelected.id)
    ) {
      await requestRecordDetail(currentSelected.id, query.jobId, { remainsCurrent });
    }
    return remainsCurrent();
  };

  return {
    recordPage,
    setRecordPage,
    page,
    pageSize,
    selected,
    filter,
    listRequestIdRef,
    intendedRecordQueryRef,
    committedRecordQueryRef,
    recordPageRef,
    detailRequestIdRef,
    selectedRef,
    detailRevisionRef,
    detailDirtyRef,
    setSelectedRecord,
    clearSelectedRecord,
    editSelectedRecord,
    isLatestListRequest,
    beginListRequest,
    loadValidRecordPage,
    commitRecordPage,
    rollbackLatestListRequest,
    requestRecordDetail,
    requestPage,
    changeRecordPage,
    changePageSize,
    changeFilter,
    refreshCurrentRecordPage,
  };
}
