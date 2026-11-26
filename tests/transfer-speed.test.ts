import { describe, expect, it } from 'vitest';
import { formatTransferSpeed, formatTransferTimeRemaining } from '../src/shared/transfer-speed';

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

describe('transfer time remaining', () => {
  it('uses readable seconds, minutes, hours, and days', () => {
    expect(formatTransferTimeRemaining(750, 1_000)).toBe('1 sec');
    expect(formatTransferTimeRemaining(125_000, 1_000)).toBe('2 min 5 sec');
    expect(formatTransferTimeRemaining(3_660_000, 1_000)).toBe('1 hr 1 min');
    expect(formatTransferTimeRemaining(176_400_000, 1_000)).toBe('2 days 1 hr');
    expect(formatTransferTimeRemaining(100 * 86_400_000, 1_000)).toBe('over 99 days');
  });
  it('returns no estimate until progress and speed are usable', () => {
    for (const rate of [0, -1, NaN, Infinity]) expect(formatTransferTimeRemaining(100, rate)).toBeNull();
    expect(formatTransferTimeRemaining(-1, 100)).toBeNull();
  });
});
