import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultWindowSize, WindowSizeStore } from '../src/main/window-size-store';

const directories: string[] = [];
async function make() {
  const directory = await mkdtemp(join(tmpdir(), 's3-window-size-'));
  directories.push(directory);
  return { directory, store: new WindowSizeStore(directory) };
}
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe('window size preferences', () => {
  it('restores dimensions and maximized state, then resets both to defaults', async () => {
    const { directory, store } = await make();
    expect(store.load()).toEqual(defaultWindowSize);
    store.save({ width: 1460, height: 910, maximized: true });
    expect(new WindowSizeStore(directory).load()).toEqual({ width: 1460, height: 910, maximized: true });
    store.reset();
    expect(new WindowSizeStore(directory).load()).toEqual(defaultWindowSize);
    expect(JSON.parse(await readFile(join(directory, 'window-size.json'), 'utf8'))).toEqual(defaultWindowSize);
  });

  it('ignores damaged or out-of-range settings', async () => {
    const { directory, store } = await make();
    await writeFile(join(directory, 'window-size.json'), '{broken');
    expect(store.load()).toEqual(defaultWindowSize);
    await writeFile(join(directory, 'window-size.json'), JSON.stringify({ width: 100, height: 90000, maximized: 'yes' }));
    expect(store.load()).toEqual(defaultWindowSize);
  });
});
