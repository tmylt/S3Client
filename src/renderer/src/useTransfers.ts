import { useCallback, useEffect, useState } from 'react';
import { emptyTransferSnapshot, type TransferAction, type TransferDirection } from '../../shared/transfers';

export function useTransfers() {
  const [snapshot, setSnapshot] = useState(emptyTransferSnapshot);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    let receivedUpdate = false;
    const unsubscribe = window.s3?.onTransfers?.(next => {
      receivedUpdate = true;
      if (active) setSnapshot(next);
    });
    // This only reads the local transfer queue. Browsing S3 remains on demand.
    if (window.s3?.transfers) {
      void window.s3.transfers().then(next => {
        if (active && !receivedUpdate) setSnapshot(next);
      }).catch(cause => { if (active && !receivedUpdate) setError(message(cause)); });
    }
    return () => { active = false; unsubscribe?.(); };
  }, []);
  const execute = useCallback(async (operation: () => Promise<void>) => {
    setError('');
    try { await operation(); }
    catch (cause) { setError(message(cause)); }
  }, []);
  const control = useCallback((id: string, action: TransferAction) => execute(() => window.s3.controlTransfer(id, action)), [execute]);
  const controlAll = useCallback((direction: TransferDirection, action: TransferAction) => execute(() => window.s3.controlTransfers(direction, action)), [execute]);
  const remove = useCallback((id: string) => execute(() => window.s3.removeTransfer(id)), [execute]);
  const clear = useCallback((direction: TransferDirection) => execute(() => window.s3.clearTransfers(direction)), [execute]);
  const setConcurrency = useCallback((direction: TransferDirection, concurrency: number) => execute(() => window.s3.setTransferConcurrency(direction, concurrency)), [execute]);
  return { snapshot, error, control, controlAll, remove, clear, setConcurrency };
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : 'Unable to update transfers.';
}
