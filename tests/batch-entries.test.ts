import { describe, expect, it } from 'vitest';
import { validateEntryTargets } from '../src/main/batch-entries';

describe('bulk entry targets', () => {
  it('keeps a unique file and folder selection in its displayed order', () => {
    expect(validateEntryTargets([{ key: 'root/a', kind: 'file' }, { key: 'root/folder/', kind: 'folder' }])).toEqual([
      { key: 'root/a', kind: 'file' }, { key: 'root/folder/', kind: 'folder' },
    ]);
  });

  it.each([[], [{ key: 'a', kind: 'file' }, { key: 'a', kind: 'file' }], [{ key: 'a', kind: 'invalid' }], [{ key: '', kind: 'file' }], Array.from({ length: 1001 }, (_, index) => ({ key: String(index), kind: 'file' }))])('rejects an invalid or excessive selection', value => {
    expect(() => validateEntryTargets(value)).toThrow(/selection/i);
  });
});
