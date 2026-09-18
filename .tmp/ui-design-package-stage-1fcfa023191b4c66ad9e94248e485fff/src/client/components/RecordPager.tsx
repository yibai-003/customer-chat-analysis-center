interface RecordPagerProps {
  page: number;
  total: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
}

const PAGE_SIZE_OPTIONS = [20, 50, 100, 200];

export function RecordPager({
  page,
  total,
  pageSize,
  onPageChange,
  onPageSizeChange,
}: RecordPagerProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = total === 0 ? 1 : Math.min(Math.max(page, 1), totalPages);
  const start = total === 0 ? 0 : ((currentPage - 1) * pageSize) + 1;
  const end = total === 0 ? 0 : Math.min(currentPage * pageSize, total);

  return (
    <nav className="record-pager" aria-label="记录分页">
      <label>
        <span>每页</span>
        <select
          aria-label="每页记录数"
          value={pageSize}
          disabled={!onPageSizeChange}
          onChange={(event) => onPageSizeChange?.(Number(event.target.value))}
        >
          {PAGE_SIZE_OPTIONS.map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
      </label>
      <output aria-live="polite">{start}-{end} / {total}</output>
      <button
        type="button"
        aria-label="上一页"
        title="上一页"
        disabled={total === 0 || currentPage <= 1}
        onClick={() => onPageChange(currentPage - 1)}
      >
        ‹
      </button>
      <button
        type="button"
        aria-label="下一页"
        title="下一页"
        disabled={total === 0 || currentPage >= totalPages}
        onClick={() => onPageChange(currentPage + 1)}
      >
        ›
      </button>
    </nav>
  );
}
