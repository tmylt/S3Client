export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type ExtraConfig = { [key: string]: JsonValue };
import type { TransferAction, TransferDirection, TransferSnapshot } from './transfers';

export interface ConnectionPermissions { download: boolean; upload: boolean; delete: boolean }

export interface Connection {
  id: string;
  name: string;
  endpoint: string;
  bucket: string;
  uriScheme?: string;
  prefix: string;
  region: string | null;
  defaultPageSize?: number;
  hasCredentials: boolean;
  extraConfig?: ExtraConfig;
  permissions?: ConnectionPermissions;
}

export interface ConnectionDetails extends Connection {
  accessKey: string;
  secretKey: string;
}

export interface ConnectionInput {
  id?: string;
  name: string;
  endpoint: string;
  bucket: string;
  uriScheme?: string;
  prefix: string;
  region: string | null;
  defaultPageSize?: number;
  accessKey?: string;
  secretKey?: string;
  sessionToken?: string;
  extraConfig?: ExtraConfig;
  permissions?: ConnectionPermissions;
}

export interface Credentials {
  accessKey: string;
  secretKey: string;
  sessionToken?: string;
}

export interface FolderStats {
  fileCount: number;
  totalSize: number;
  updatedAt: string;
  durationMs: number;
}

export interface Entry {
  key: string;
  name: string;
  kind: 'folder' | 'file';
  size: number | null;
  modified: string | null;
  storageClass?: string;
  stats?: FolderStats;
}
export interface EntryTarget { key: string; kind: 'folder' | 'file' }
export interface BatchEntryResult { succeeded: number; failed: { key: string; message: string }[] }

export interface Listing { entries: Entry[]; nextToken?: string | null }
export type SearchRange = 'page' | 'folder' | 'recursive' | 'key';
export type RemoteSearchRange = Exclude<SearchRange, 'page'>;
export type SearchMatch = 'prefix' | 'contains' | 'exact';

export interface CachedListing extends Listing {
  connectionId: string;
  prefix: string;
  updatedAt: string;
  pageSize?: number;
  pageIndex?: number;
}

export interface ConfirmationRequest {
  id: string;
  kind: 'file' | 'folder' | 'entry-batch' | 'connection' | 'transfer' | 'transfer-list';
  name: string;
  path: string;
}
export type ConfirmationAnswer = boolean | 'keep-active';

export interface UploadSource { name: string; path: string; kind: 'file' | 'folder' }
export interface UploadSources { directory: string; parent: string | null; entries: UploadSource[] }

export interface VideoOpen { id: string; mode: 'stream' | 'download'; total: number; url?: string }
export type VideoEvent =
  | { id: string; event: 'progress'; received: number; total: number }
  | { id: string; event: 'ready'; url: string; total: number }
  | { id: string; event: 'error'; message: string };

export interface S3API {
  connections(): Promise<{ connections: Connection[]; secureStorage: boolean; cachedListings?: CachedListing[] }>;
  connectionDetails(id: string): Promise<ConnectionDetails>;
  saveConnection(input: ConnectionInput): Promise<Connection>;
  copyConnection(id: string): Promise<Connection>;
  reorderConnections(ids: string[]): Promise<void>;
  removeConnection(id: string): Promise<boolean>;
  list(connectionId: string, prefix: string, pageSize?: number, continuationToken?: string | null, pageIndex?: number): Promise<Listing>;
  search(connectionId: string, prefix: string, range: RemoteSearchRange, match: SearchMatch, name: string, pageSize?: number, continuationToken?: string | null): Promise<Listing>;
  searchUri(connectionId: string, key: string): Promise<Listing>;
  stats(connectionId: string, prefix: string): Promise<FolderStats>;
  copyText(text: string): Promise<void>;
  download(connectionId: string, key: string, kind: 'file' | 'folder'): Promise<string | null>;
  downloadEntries(connectionId: string, entries: EntryTarget[]): Promise<BatchEntryResult | null>;
  uploadSources(connectionId: string, prefix: string, directory?: string): Promise<UploadSources>;
  upload(connectionId: string, prefix: string, paths: string[]): Promise<string | null>;
  openVideo(connectionId: string, key: string): Promise<VideoOpen>;
  startVideo(id: string): Promise<void>;
  closeVideo(id: string): Promise<void>;
  onVideoEvent(listener: (event: VideoEvent) => void): () => void;
  deleteEntry(connectionId: string, key: string, kind: 'file' | 'folder'): Promise<boolean>;
  copyEntry(connectionId: string, key: string, kind: 'file' | 'folder', destinationFolder: string, name: string): Promise<number>;
  renameEntry(connectionId: string, key: string, kind: 'file' | 'folder', name: string): Promise<number>;
  deleteEntries(connectionId: string, entries: EntryTarget[]): Promise<BatchEntryResult | null>;
  transfers(): Promise<TransferSnapshot>;
  controlTransfer(id: string, action: TransferAction): Promise<void>;
  controlTransfers(direction: TransferDirection, action: TransferAction): Promise<void>;
  removeTransfer(id: string): Promise<void>;
  clearTransfers(direction: TransferDirection): Promise<void>;
  setTransferConcurrency(direction: TransferDirection, concurrency: number): Promise<void>;
  onTransfers(listener: (snapshot: TransferSnapshot) => void): () => void;
  onStorageChanged(listener: (connectionId: string) => void): () => void;
  onConfirmation(listener: (request: ConfirmationRequest) => void): () => void;
  answerConfirmation(id: string, answer: ConfirmationAnswer): Promise<void>;
  onResetViewSizes(listener: () => void): () => void;
}

declare global {
  interface Window { s3: S3API }
}
