import type { Page } from 'playwright';

export function isSameDocumentNavigation(currentUrl: string, targetUrl: string): boolean {
  try {
    const current = new URL(currentUrl);
    const target = new URL(targetUrl);
    return current.origin === target.origin
      && current.pathname === target.pathname
      && current.search === target.search;
  } catch {
    return false;
  }
}

export async function fullLoad(page: Page, url: string): Promise<void> {
  if (isSameDocumentNavigation(page.url(), url)) {
    // The JLC SPA treats a hash-only change as an in-app transition and rewrites
    // the URL with tracking/embed parameters (for example `fullPath=false`), which
    // renders the target view in a reduced embedded mode. On Windows this leaves
    // pages such as the PCB order upload view without their file input. Routing
    // through a blank page forces a real full-document load of the clean URL.
    await page.goto('about:blank');
  }
  await page.goto(url, { waitUntil: 'domcontentloaded' });
}
