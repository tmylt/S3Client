import { describe, expect, it } from 'vitest';
import { normalizeExtraConfig, parseExtraConfig, serializeExtraConfig } from '../src/shared/extra-config';

describe('extra S3 config', () => {
  it('accepts blank input and parses virtual addressing as a JSON object', () => {
    expect(parseExtraConfig('  ')).toEqual({});
    expect(normalizeExtraConfig(undefined)).toEqual({});
    expect(parseExtraConfig('{"s3":{"addressing_style":"virtual"}}')).toEqual({ s3: { addressing_style: 'virtual' } });
  });
  it('copies JSON data and canonicalizes object ordering without changing arrays or values', () => {
    const input = { s3: { addressing_style: 'virtual' }, retries: { mode: 'adaptive' }, other: [null, true, 2, 'value'] };
    const copy = normalizeExtraConfig(input);
    input.s3.addressing_style = 'path';
    expect(copy.s3).toEqual({ addressing_style: 'virtual' });
    expect(serializeExtraConfig({ s3: { addressing_style: 'virtual' }, retries: { mode: 'adaptive' } })).toBe(serializeExtraConfig({ retries: { mode: 'adaptive' }, s3: { addressing_style: 'virtual' } }));
  });
  it('rejects malformed, non-object, unsafe and unsupported JSON values with fixed errors', () => {
    for (const value of [null, [], 'text', { value: Infinity }, { value: undefined }, { value: () => 1 }, { value: new Date() }, JSON.parse('{"__proto__":{"unsafe":true}}')]) {
      expect(() => normalizeExtraConfig(value)).toThrow(/extra config/i);
    }
    expect(() => parseExtraConfig('{s3: PRIVATE_VALUE}')).toThrow(/valid JSON/i);
    expect(() => parseExtraConfig('{s3: PRIVATE_VALUE}')).not.toThrow(/PRIVATE_VALUE/);
    expect(() => normalizeExtraConfig({ value: 'x'.repeat(70_000) })).toThrow(/extra config/i);
    const cyclic: Record<string, unknown> = {}; cyclic.value = cyclic;
    expect(() => normalizeExtraConfig(cyclic)).toThrow(/extra config/i);
  });
});
