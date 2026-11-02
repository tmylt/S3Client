import { describe, expect, it } from 'vitest';
import { formatTransferSpeed } from '../src/shared/transfer-speed';

describe('transfer speed units', () => {
  it('formats bytes per second with decimal kB, MB, and larger units', () => {
    expect(formatTransferSpeed(110_000)).toBe('110kB/s');
    expect(formatTransferSpeed(1_200_000)).toBe('1.2MB/s');
    expect(formatTransferSpeed(25_000_000)).toBe('25MB/s');
    expect(formatTransferSpeed(1_500_000_000)).toBe('1.5GB/s');
    expect(formatTransferSpeed(42)).toBe('42B/s');
    expect(formatTransferSpeed(999_999)).toBe('1MB/s');
  });
  it('treats unavailable or invalid measurements as zero', () => {
    for (const rate of [0, -1, Infinity, NaN]) expect(formatTransferSpeed(rate)).toBe('0B/s');
  });
});
