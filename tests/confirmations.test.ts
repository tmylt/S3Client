import { describe, expect, it, vi } from 'vitest';
import { Confirmations } from '../src/main/confirmations';
import type { ConfirmationRequest } from '../src/shared/types';

const target = { kind: 'folder' as const, name: 'photos', path: 's3://bucket/photos/' };

describe('destructive confirmation', () => {
  it('waits for an explicit answer for the current single-use request', async () => {
    const send = vi.fn<(request: ConfirmationRequest) => void>();
    const confirmations = new Confirmations(send);
    const pending = confirmations.ask(target);
    const request = send.mock.calls[0][0];
    let resolved = false; void pending.then(() => { resolved = true; });
    confirmations.respond('wrong-id', true);
    confirmations.respond(request.id, 'true');
    await Promise.resolve();
    expect(resolved).toBe(false);
    confirmations.respond(request.id, true);
    await expect(pending).resolves.toBe(true);
    const next = confirmations.ask(target);
    confirmations.respond(request.id, true);
    confirmations.cancel();
    await expect(next).resolves.toBe(false);
  });

  it('cancels on dismissal, lifecycle changes, delivery failure, or concurrent requests', async () => {
    const send = vi.fn<(request: ConfirmationRequest) => void>();
    const confirmations = new Confirmations(send);
    const first = confirmations.ask(target);
    await expect(confirmations.ask(target)).resolves.toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    confirmations.respond(send.mock.calls[0][0].id, false);
    await expect(first).resolves.toBe(false);
    const reloaded = confirmations.ask(target);
    confirmations.cancel();
    await expect(reloaded).resolves.toBe(false);
    send.mockImplementationOnce(() => { throw new Error('Window closed'); });
    await expect(confirmations.ask(target)).resolves.toBe(false);
    const recovered = confirmations.ask(target);
    confirmations.respond(send.mock.calls.at(-1)![0].id, true);
    await expect(recovered).resolves.toBe(true);
  });

  it('accepts keep-active only for a transfer list confirmation', async () => {
    const send = vi.fn<(request: ConfirmationRequest) => void>();
    const confirmations = new Confirmations(send);
    const deletion = confirmations.ask(target);
    confirmations.respond(send.mock.calls.at(-1)![0].id, 'keep-active');
    confirmations.cancel();
    await expect(deletion).resolves.toBe(false);
    const clearing = confirmations.ask({ kind: 'transfer-list', name: 'Downloads', path: '' });
    confirmations.respond(send.mock.calls.at(-1)![0].id, 'keep-active');
    await expect(clearing).resolves.toBe('keep-active');
  });
});
