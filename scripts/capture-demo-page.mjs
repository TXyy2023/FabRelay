// Read-only CDP screenshot capture after the business CLI has disconnected.
// Usage: node scripts/capture-demo-page.mjs endpoint targetId private-output-directory
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const [endpoint, targetId, output] = process.argv.slice(2);
await mkdir(output, { recursive: true, mode: 0o700 });
const browser = await chromium.connectOverCDP(endpoint);
try {
  let target;
  const pages = [];
  for (const context of browser.contexts()) for (const page of context.pages()) {
    const session = await context.newCDPSession(page);
    const { targetInfo } = await session.send('Target.getTargetInfo');
    await session.detach();
    pages.push({ targetId: targetInfo.targetId, url: page.url(), title: await page.title() });
    if (targetInfo.targetId === targetId) target = page;
  }
  if (!target) throw new Error('Original task target is unavailable; refusing to replace it.');
  await target.setViewportSize({ width: 1600, height: 1000 });
  await target.evaluate(() => window.scrollTo(0, 0));
  await target.screenshot({ path: path.join(output, 'page-private.png') });
  await writeFile(path.join(output, 'page-inspect.json'), JSON.stringify({ endpoint, targetId, pages, capturedAt: new Date().toISOString(), text: await target.locator('body').innerText() }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ captured: true, targetId, pageCount: pages.length, output }));
} finally {
  await browser.close();
}
