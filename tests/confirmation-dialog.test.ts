// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmationDialog } from '../src/renderer/src/components/ConfirmationDialog';
import type { ConfirmationRequest } from '../src/shared/types';

afterEach(cleanup);
const request: ConfirmationRequest = { id: 'request', kind: 'folder', name: 'photos', path: 's3://bucket/workspace/photos/' };

describe('styled confirmation dialog', () => {
  it.each(['transfer', 'transfer-list'] as const)('distinguishes removing %s history from deleting files', kind => {
    const onAnswer = vi.fn();
    render(createElement(ConfirmationDialog, { request: { id: 'history', kind, name: 'Downloads', path: '' }, onAnswer }));
    const dialog = screen.getByRole('alertdialog', { name: kind === 'transfer-list' ? 'Clear downloads?' : 'Remove transfer?' });
    expect(dialog.textContent).toContain('Completed files and S3 objects will be kept.');
    expect(dialog.textContent).toContain(kind === 'transfer-list' ? 'Keep unfinished transfers' : 'Active transfers will be cancelled');
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(dialog).getByRole('button', { name: kind === 'transfer-list' ? 'Cancel tasks and clear all' : 'Remove row' }));
    expect(onAnswer).toHaveBeenCalledWith(true);
  });
  it('can clear finished rows while keeping unfinished transfers', () => {
    const onAnswer = vi.fn();
    render(createElement(ConfirmationDialog, { request: { id: 'history', kind: 'transfer-list', name: 'Uploads', path: '' }, onAnswer }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep tasks and clear finished' }));
    expect(onAnswer).toHaveBeenCalledWith('keep-active');
  });
  it('asks once before deleting a selected group of files and folders', () => {
    const onAnswer = vi.fn();
    render(createElement(ConfirmationDialog, { request: { id: 'batch', kind: 'entry-batch', name: '3 selected items', path: 's3://bucket/root/' }, onAnswer }));
    const dialog = screen.getByRole('alertdialog', { name: 'Delete selected items?' });
    expect(dialog.textContent).toContain('selected folders');
    expect(dialog.textContent).toContain('3 selected items');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete 3 items' }));
    expect(onAnswer).toHaveBeenCalledWith(true);
  });
  it('identifies the folder and its scope, defaults to Cancel, traps focus, and restores it', () => {
    const opener = document.createElement('button'); document.body.append(opener); opener.focus();
    const onAnswer = vi.fn();
    const view = render(createElement(ConfirmationDialog, { request, onAnswer }));
    const dialog = screen.getByRole('alertdialog', { name: 'Delete folder?' });
    expect(within(dialog).getByText(request.name)).toBeTruthy();
    expect(within(dialog).getByText(request.path)).toBeTruthy();
    expect(dialog.textContent).toContain('all files and subfolders');
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    const buttons = within(dialog).getAllByRole('button');
    buttons.at(-1)!.focus(); fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(document.activeElement).toBe(buttons[0]);
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(buttons.at(-1));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onAnswer).toHaveBeenCalledWith(false);
    view.unmount(); expect(document.activeElement).toBe(opener); opener.remove();
  });

  it.each(['Cancel', 'Close confirmation'])('cancels using %s', name => {
    const onAnswer = vi.fn(); render(createElement(ConfirmationDialog, { request, onAnswer }));
    fireEvent.click(screen.getByRole('button', { name }));
    expect(onAnswer).toHaveBeenCalledWith(false);
  });

  it('cancels outside clicks and only confirms on the explicit destructive button', () => {
    const onAnswer = vi.fn(); const { container } = render(createElement(ConfirmationDialog, { request, onAnswer }));
    fireEvent.mouseDown(screen.getByText(request.name)); expect(onAnswer).not.toHaveBeenCalled();
    fireEvent.mouseDown(container.querySelector('.modal-overlay')!); expect(onAnswer).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByRole('button', { name: 'Delete folder' })); expect(onAnswer).toHaveBeenLastCalledWith(true);
  });

  it('distinguishes saved connection removal from remote deletion', () => {
    const onAnswer = vi.fn();
    render(createElement(ConfirmationDialog, { request: { ...request, kind: 'connection', name: 'Storage' }, onAnswer }));
    const dialog = screen.getByRole('alertdialog', { name: 'Remove connection?' });
    expect(dialog.textContent).toContain('files in S3 will be kept');
    expect(dialog.textContent).toContain('Unfinished operations');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove connection' }));
    expect(onAnswer).toHaveBeenCalledWith(true);
  });
});
