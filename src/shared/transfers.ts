export type TransferDirection = 'download' | 'upload';
export type TransferStatus = 'queued' | 'running' | 'paused' | 'completed' | 'cancelled' | 'failed';
export type TransferAction = 'start' | 'stop' | 'cancel';

export interface TransferTask {
  id: string;
  groupId: string;
  direction: TransferDirection;
  connectionId: string;
  connectionName: string;
  bucket: string;
  key: string;
  relativePath: string;
  localPath: string;
  rootPath: string;
  size: number;
  transferred: number;
  /** Live average for the current attempt; omitted from persisted history. */
  bytesPerSecond?: number;
  isDirectory: boolean;
  status: TransferStatus;
  error?: string;
  createdAt: string;
  finishedAt?: string;
}

export type NewTransferTask = Omit<TransferTask, 'id' | 'transferred' | 'bytesPerSecond' | 'status' | 'createdAt' | 'finishedAt' | 'error'>;

export interface TransferPreparation {
  id: string;
  direction: TransferDirection;
  connectionId: string;
  name: string;
  status: 'preparing' | 'failed' | 'cancelled';
  error?: string;
}

export interface TransferSnapshot {
  tasks: TransferTask[];
  preparations: TransferPreparation[];
  paused: Record<TransferDirection, boolean>;
  concurrency: Record<TransferDirection, number>;
}

export const emptyTransferSnapshot = (): TransferSnapshot => ({ tasks: [], preparations: [], paused: { download: false, upload: false }, concurrency: { download: 1, upload: 1 } });
