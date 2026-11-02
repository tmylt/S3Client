import type { Page } from '@playwright/test';

// Hidden is the safe default on workstations. Visible windows are opt-in for visual debugging.
export const showTestWindow = process.env.S3_CLIENT_E2E_VISIBLE === '1';

export async function captureTestScreenshot(page: Page, path: string): Promise<void> {
  if (showTestWindow) await page.screenshot({ path });
}
