export const pageSizes = [100, 250, 500, 1000] as const;
export const defaultPageSize = 1000;

export function isPageSize(value: unknown): value is number {
  return typeof value === 'number' && pageSizes.some(size => size === value);
}
