import { useEffect, useRef, useState } from 'react';
import { Cloud, Eye, EyeOff, LoaderCircle, LockKeyhole, X } from 'lucide-react';
import type { ConnectionDetails, ConnectionInput } from '../../../shared/types';
import { parseExtraConfig } from '../../../shared/extra-config';
import { connectionPermissions } from '../../../shared/permissions';
import { defaultPageSize, pageSizes } from '../../../shared/page-size';
import { isConnectionUri } from '../../../shared/storage-uri';

interface Props {
  connection?: ConnectionDetails;
  secureStorage: boolean;
  onSave(input: ConnectionInput): Promise<void>;
  onClose(): void;
}

export function ConnectionDialog({ connection, secureStorage, onSave, onClose }: Props) {
  const dialog = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reveal, setReveal] = useState(false);
  const [extraConfigText, setExtraConfigText] = useState(connection?.extraConfig && Object.keys(connection.extraConfig).length ? JSON.stringify(connection.extraConfig, null, 2) : '');
  const [form, setForm] = useState<ConnectionInput>({ id: connection?.id, name: connection?.name || '', endpoint: connection?.endpoint || 'https://s3.amazonaws.com', bucket: connection?.bucket || '', uriScheme: connection?.uriScheme || 's3', prefix: connection?.prefix || '', region: connection ? connection.region ?? '' : 'us-east-1', defaultPageSize: connection?.defaultPageSize ?? defaultPageSize, accessKey: connection?.accessKey ?? '', secretKey: connection?.secretKey ?? '', sessionToken: '', permissions: connectionPermissions(connection?.permissions) });
  const busyRef = useRef(false);
  busyRef.current = busy;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLInputElement>('input')?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) { event.preventDefault(); onClose(); }
      if (event.key !== 'Tab') return;
      const elements = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]') || []);
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', handleKey);
    return () => { document.removeEventListener('keydown', handleKey); previous?.focus(); };
  }, [onClose]);

  const set = (field: keyof ConnectionInput, value: string) => setForm(current => ({ ...current, [field]: value }));
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    let extraConfig;
    try { extraConfig = parseExtraConfig(extraConfigText); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Extra config must be valid JSON.'); return; }
    setBusy(true); setError('');
    // Preserve the saved session token when both displayed keys are unchanged.
    const unchanged = connection && form.accessKey === connection.accessKey && form.secretKey === connection.secretKey && !form.sessionToken;
    try { await onSave({ ...form, ...(unchanged ? { secretKey: '' } : {}), extraConfig }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to save this connection.'); setBusy(false); }
  };

  return <div className="modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div ref={dialog} className="connection-dialog" role="dialog" aria-modal="true" aria-labelledby="connection-title">
      <button className="icon-button dialog-close" aria-label="Close connection dialog" onClick={onClose} disabled={busy}><X size={18} /></button>
      <div className="dialog-icon"><Cloud size={27} strokeWidth={1.6} /></div>
      <h2 id="connection-title">{connection ? 'Edit connection' : 'Connect your storage'}</h2>
      <p className="dialog-description">Browse any S3-compatible bucket, right from your desktop.</p>
      <form onSubmit={submit}>
        <fieldset disabled={busy}>
          <label>Connection name<input value={form.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Production storage" required maxLength={100} autoComplete="off" /></label>
          <label>Endpoint URL<input value={form.endpoint} onChange={e => set('endpoint', e.target.value)} placeholder="https://s3.amazonaws.com" type="url" required autoComplete="off" spellCheck={false} /></label>
          <div className="form-columns">
            <label>Bucket<input value={form.bucket} onChange={e => set('bucket', e.target.value)} placeholder="my-bucket" required={!isConnectionUri(form.prefix, form.uriScheme)} autoComplete="off" spellCheck={false} /></label>
            <label>Region <span className="optional">optional</span><input value={form.region ?? ''} onChange={e => set('region', e.target.value)} autoComplete="off" spellCheck={false} /></label>
          </div>
          <label>URI scheme<input value={form.uriScheme} onChange={e => set('uriScheme', e.target.value)} placeholder="s3, obs, or oss" required maxLength={32} autoComplete="off" spellCheck={false} /><span className="field-hint">Used in copied object and folder URIs. S3 API access still uses the endpoint above.</span></label>
          <label>Prefix <span className="optional">optional</span><input value={form.prefix} onChange={e => set('prefix', e.target.value)} placeholder={`path/to/folder/ or ${form.uriScheme || 's3'}://bucket/path/`} autoComplete="off" spellCheck={false} /><span className="field-hint">Your connection starts here. Leave empty to browse the whole bucket.</span></label>
          <label>Default page size<select value={form.defaultPageSize ?? defaultPageSize} onChange={event => setForm(current => ({ ...current, defaultPageSize: Number(event.target.value) }))}>{pageSizes.map(size => <option key={size} value={size}>{size.toLocaleString()}</option>)}</select><span className="field-hint">Used when this connection opens. Page size changes while browsing last until you close the app.</span></label>
          <label>Extra config (JSON) <span className="optional">optional</span><textarea value={extraConfigText} onChange={event => setExtraConfigText(event.target.value)} rows={3} maxLength={65536} spellCheck={false} placeholder={'{"s3":{"addressing_style":"virtual"}}'} /><span className="field-hint">S3 addressing style, retry, and timeout options. For Aliyun, use the virtual addressing example above.</span></label>
          <div className="connection-permissions">
            {(['download', 'upload', 'delete'] as const).map(operation => <label key={operation}><input type="checkbox" checked={form.permissions?.[operation] ?? false} onChange={event => setForm(current => ({ ...current, permissions: { ...connectionPermissions(current.permissions), [operation]: event.target.checked } }))} />Allow {operation}s</label>)}
          </div>
          <div className="form-divider" />
          <label>Access key (AK)<input value={form.accessKey} onChange={e => set('accessKey', e.target.value)} placeholder="Your access key ID" required={!connection?.hasCredentials} autoComplete="off" spellCheck={false} /></label>
          <label>Secret key (SK)<span className="password-field"><input value={form.secretKey} onChange={e => set('secretKey', e.target.value)} placeholder={connection?.hasCredentials ? 'Saved · leave blank to keep' : 'Your secret access key'} type={reveal ? 'text' : 'password'} required={!connection?.hasCredentials} autoComplete="new-password" spellCheck={false} /><button className="icon-button" type="button" aria-label={reveal ? 'Hide secret key' : 'Show secret key'} onClick={() => setReveal(!reveal)}>{reveal ? <EyeOff size={16} /> : <Eye size={16} />}</button></span></label>
          <details className="advanced-fields"><summary>Temporary credentials</summary><label>Session token <span className="optional">optional</span><input value={form.sessionToken} onChange={e => set('sessionToken', e.target.value)} placeholder={connection?.hasCredentials ? 'Leave blank to keep the saved token' : 'For temporary AWS credentials'} type="password" autoComplete="new-password" /></label></details>
        </fieldset>
        <div className="credential-note"><LockKeyhole size={14} /><span>{secureStorage ? 'Credentials are encrypted with your operating system’s secure storage.' : 'Secure storage is unavailable. Keys stay in memory; re-enter them after restarting.'}</span></div>
        {error && <div role="alert" className="form-error">{error}</div>}
        <div className="dialog-footer"><button type="button" className="button secondary" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" className="button primary" disabled={busy}>{busy && <LoaderCircle size={15} className="spin" />}{busy ? 'Saving…' : connection ? 'Save connection' : 'Connect & browse'}</button></div>
      </form>
    </div>
  </div>;
}
