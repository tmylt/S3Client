// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionDialog } from '../src/renderer/src/components/ConnectionDialog';

afterEach(cleanup);
const configured = { id: 'existing', name: 'Warehouse', endpoint: 'https://s3.example.com', bucket: 'bucket', prefix: '', region: 'eu-west-2', hasCredentials: true, accessKey: 'CONFIGURED_AK', secretKey: 'CONFIGURED_SK' };

describe('connection edit fields', () => {
  it('starts with downloads allowed and writes changes to permission checkboxes', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { container } = render(createElement(ConnectionDialog, { secureStorage: true, onSave, onClose: vi.fn() }));
    expect((screen.getByRole('checkbox', { name: 'Allow downloads' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: 'Allow uploads' }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('checkbox', { name: 'Allow deletes' }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Allow downloads' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Allow uploads' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Allow deletes' }));
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ permissions: { download: false, upload: true, delete: true } })));
  });
  it('preserves configured permissions while retaining unchanged saved credentials', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const permissions = { download: false, upload: true, delete: true };
    const { container } = render(createElement(ConnectionDialog, { connection: { ...configured, permissions }, secureStorage: true, onSave, onClose: vi.fn() }));
    expect((screen.getByRole('checkbox', { name: 'Allow downloads' }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('checkbox', { name: 'Allow uploads' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: 'Allow deletes' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ permissions, accessKey: configured.accessKey, secretKey: '' })));
    expect(permissions).toEqual({ download: false, upload: true, delete: true });
  });
  it('displays stored extra config as JSON and saves parsed options', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const extraConfig = { s3: { addressing_style: 'virtual' } };
    const { container } = render(createElement(ConnectionDialog, { connection: { ...configured, extraConfig }, secureStorage: true, onSave, onClose: vi.fn() }));
    const field = screen.getByLabelText(/Extra config/) as HTMLTextAreaElement;
    expect(JSON.parse(field.value)).toEqual(extraConfig);
    fireEvent.change(field, { target: { value: '{"s3":{"addressing_style":"path"}}' } });
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ extraConfig: { s3: { addressing_style: 'path' } } })));
  });
  it('reports invalid extra-config JSON without saving', async () => {
    const onSave = vi.fn();
    const { container } = render(createElement(ConnectionDialog, { connection: configured, secureStorage: true, onSave, onClose: vi.fn() }));
    fireEvent.change(screen.getByLabelText(/Extra config/), { target: { value: '{invalid}' } });
    fireEvent.submit(container.querySelector('form')!);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
  });
  it('shows the configured region and AK while leaving the SK unrevealed', () => {
    render(createElement(ConnectionDialog, { connection: configured, secureStorage: true, onSave: vi.fn(), onClose: vi.fn() }));
    expect((screen.getByLabelText(/Region/) as HTMLInputElement).value).toBe('eu-west-2');
    expect((screen.getByLabelText('Access key (AK)') as HTMLInputElement).value).toBe('CONFIGURED_AK');
    const secret = screen.getByLabelText('Secret key (SK)') as HTMLInputElement;
    expect(secret.value).toBe('CONFIGURED_SK');
    expect(secret.type).toBe('password');
  });
  it('reveals the saved SK with the eye button and masks it again on reopening', () => {
    const props = { connection: configured, secureStorage: true, onSave: vi.fn(), onClose: vi.fn() };
    const view = render(createElement(ConnectionDialog, props));
    fireEvent.click(screen.getByRole('button', { name: 'Show secret key' }));
    let secret = screen.getByLabelText('Secret key (SK)') as HTMLInputElement;
    expect(secret.value).toBe('CONFIGURED_SK');
    expect(secret.type).toBe('text');
    fireEvent.click(screen.getByRole('button', { name: 'Hide secret key' }));
    expect(secret.type).toBe('password');
    fireEvent.click(screen.getByRole('button', { name: 'Show secret key' }));
    view.unmount();
    render(createElement(ConnectionDialog, props));
    secret = screen.getByLabelText('Secret key (SK)') as HTMLInputElement;
    expect(secret.value).toBe('CONFIGURED_SK');
    expect(secret.type).toBe('password');
  });
  it.each([null, ''])('shows an empty field when the saved region is %s', region => {
    render(createElement(ConnectionDialog, { connection: { ...configured, region }, secureStorage: true, onSave: vi.fn(), onClose: vi.fn() }));
    expect((screen.getByLabelText(/Region/) as HTMLInputElement).value).toBe('');
  });
  it('keeps saved credentials when submitting unchanged keys and a blank region', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { container } = render(createElement(ConnectionDialog, { connection: { ...configured, region: null }, secureStorage: true, onSave, onClose: vi.fn() }));
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ accessKey: 'CONFIGURED_AK', region: '', secretKey: '' })));
  });
  it('submits a changed secret key rather than a mask or the saved value', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { container } = render(createElement(ConnectionDialog, { connection: configured, secureStorage: true, onSave, onClose: vi.fn() }));
    fireEvent.change(screen.getByLabelText('Secret key (SK)'), { target: { value: 'UPDATED_SK' } });
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ accessKey: 'CONFIGURED_AK', secretKey: 'UPDATED_SK' })));
  });
  it('submits the actual saved SK when replacing a session token', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { container } = render(createElement(ConnectionDialog, { connection: configured, secureStorage: true, onSave, onClose: vi.fn() }));
    fireEvent.change(screen.getByLabelText(/Session token/), { target: { value: 'NEW_SESSION_TOKEN' } });
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ accessKey: 'CONFIGURED_AK', secretKey: 'CONFIGURED_SK', sessionToken: 'NEW_SESSION_TOKEN' })));
  });
});
