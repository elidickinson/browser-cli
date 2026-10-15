const assert = require('node:assert/strict');
const http = require('node:http');
const { test } = require('node:test');
const { chromium } = require('patchright');
const { navigateForScreenshot } = require('../utils');

test('screenshot navigation captures before a subresource finishes loading', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/stalled.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.write(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      return;
    }
    res.end('<!doctype html><body>capturable<img src="/stalled.png"></body>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await navigateForScreenshot(page, `http://127.0.0.1:${server.address().port}`);

    assert.equal(await page.evaluate(() => document.readyState), 'interactive');
    assert.equal(await page.locator('body').innerText(), 'capturable');
    await assert.rejects(page.waitForLoadState('load', { timeout: 100 }));
    assert.ok((await page.screenshot()).length > 0);
  } finally {
    await browser?.close();
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
  }
});
