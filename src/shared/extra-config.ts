import type { ExtraConfig, JsonValue } from './types';

const invalid = () => new Error('Extra config must be a JSON object containing only JSON values.');

function clone(value: unknown, depth = 0): JsonValue {
  if (depth > 10) throw new Error('Extra config cannot exceed 10 nested levels.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => clone(item, depth + 1));
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalid();
  const items = Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return Object.fromEntries(items.map(([key, item]) => {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw invalid();
    return [key, clone(item, depth + 1)];
  }));
}

export function normalizeExtraConfig(value: unknown): ExtraConfig {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const result = clone(value) as ExtraConfig;
  if (new TextEncoder().encode(JSON.stringify(result)).length > 64 * 1024) throw new Error('Extra config cannot exceed 64 KiB.');
  return result;
}

export function parseExtraConfig(text: string): ExtraConfig {
  if (!text.trim()) return {};
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error('Extra config must be valid JSON.'); }
  return normalizeExtraConfig(value);
}

export const serializeExtraConfig = (value: unknown): string => JSON.stringify(normalizeExtraConfig(value));
