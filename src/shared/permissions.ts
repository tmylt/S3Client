import type { ConnectionPermissions } from './types';

export function connectionPermissions(value?: Partial<ConnectionPermissions>): ConnectionPermissions {
  return { download: value?.download ?? true, upload: value?.upload ?? false, delete: value?.delete ?? false };
}
