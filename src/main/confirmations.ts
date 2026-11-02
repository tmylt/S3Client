import { randomUUID } from 'node:crypto';
import type { ConfirmationAnswer, ConfirmationRequest } from '../shared/types';

/** Holds a single destructive request until the displayed prompt is answered. */
export class Confirmations {
  private pending?: { id: string; kind: ConfirmationRequest['kind']; resolve(answer: ConfirmationAnswer): void };

  constructor(private readonly send: (request: ConfirmationRequest) => void) {}

  ask(target: Omit<ConfirmationRequest, 'id'>): Promise<ConfirmationAnswer> {
    if (this.pending) return Promise.resolve(false);
    return new Promise(resolve => {
      const id = randomUUID();
      this.pending = { id, kind: target.kind, resolve };
      try { this.send({ ...target, id }); }
      catch { this.cancel(); }
    });
  }

  respond(id: unknown, answer: unknown): void {
    if (!this.pending || id !== this.pending.id || !(typeof answer === 'boolean' || (answer === 'keep-active' && this.pending.kind === 'transfer-list'))) return;
    const { resolve } = this.pending;
    this.pending = undefined;
    resolve(answer);
  }

  cancel(): void {
    if (this.pending) this.respond(this.pending.id, false);
  }
}
