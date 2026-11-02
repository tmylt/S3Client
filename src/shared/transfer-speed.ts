/** Decimal byte-rate units, separate from binary file-size formatting. */
export function formatTransferSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '0B/s';
  const units = ['B/s', 'kB/s', 'MB/s', 'GB/s', 'TB/s', 'PB/s'];
  let index = Math.min(units.length - 1, Math.max(0, Math.floor(Math.log(bytesPerSecond) / Math.log(1000))));
  let value = bytesPerSecond / 1000 ** index;
  if (Math.round(value) >= 1000 && index < units.length - 1) { index++; value /= 1000; }
  return `${Number(value.toFixed(value < 10 ? 1 : 0))}${units[index]}`;
}
