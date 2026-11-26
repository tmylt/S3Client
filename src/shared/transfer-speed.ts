/** Decimal byte-rate units, separate from binary file-size formatting. */
export function formatTransferSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '0B/s';
  const units = ['B/s', 'kB/s', 'MB/s', 'GB/s', 'TB/s', 'PB/s'];
  let index = Math.min(units.length - 1, Math.max(0, Math.floor(Math.log(bytesPerSecond) / Math.log(1000))));
  let value = bytesPerSecond / 1000 ** index;
  if (Math.round(value) >= 1000 && index < units.length - 1) { index++; value /= 1000; }
  return `${Number(value.toFixed(value < 10 ? 1 : 0))}${units[index]}`;
}

/** Approximate time left at the transfer's current average speed. */
export function formatTransferTimeRemaining(remainingBytes: number, bytesPerSecond: number): string | null {
  if (!Number.isFinite(remainingBytes) || remainingBytes < 0 || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return null;
  const seconds = Math.ceil(remainingBytes / bytesPerSecond);
  if (seconds > 99 * 86_400 || !Number.isFinite(seconds)) return 'over 99 days';
  if (seconds >= 86_400) {
    const days = Math.floor(seconds / 86_400), hours = Math.floor(seconds % 86_400 / 3_600);
    return `${days} ${days === 1 ? 'day' : 'days'}${hours ? ` ${hours} hr` : ''}`;
  }
  if (seconds >= 3_600) {
    const hours = Math.floor(seconds / 3_600), minutes = Math.floor(seconds % 3_600 / 60);
    return `${hours} hr${minutes ? ` ${minutes} min` : ''}`;
  }
  if (seconds >= 60) {
    const minutes = Math.floor(seconds / 60), remainder = seconds % 60;
    return `${minutes} min${remainder ? ` ${remainder} sec` : ''}`;
  }
  return `${seconds} sec`;
}
