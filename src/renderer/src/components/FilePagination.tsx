import { pageSizes } from '../../../shared/page-size';

interface Props {
  page: number;
  pageSize: number;
  hasNext: boolean;
  loading: boolean;
  onPrevious(): void;
  onNext(): void;
  onPageSize(size: number): void;
  hint?: string;
}

export function FilePagination({ page, pageSize, hasNext, loading, onPrevious, onNext, onPageSize, hint = 'Search and sorting apply to this page.' }: Props) {
  return <div className="file-pagination">
    <span className="file-page-hint">{hint}</span>
    <div className="file-page-controls">
      <label>Page size <select aria-label="Page size" value={pageSize} disabled={loading} onChange={event => onPageSize(Number(event.target.value))}>
        {pageSizes.map(size => <option key={size} value={size}>{size.toLocaleString()}</option>)}
      </select></label>
      <button className="button secondary" aria-label="Previous page" disabled={loading || page === 0} onClick={onPrevious}>Previous</button>
      <span>Page {page + 1}</span>
      <button className="button secondary" aria-label="Next page" disabled={loading || !hasNext} onClick={onNext}>Next</button>
    </div>
  </div>;
}
