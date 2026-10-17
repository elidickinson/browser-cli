const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { test } = require('node:test');
const { chromium } = require('patchright');

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  });
}

test('web UI downloads MHTML archives and keeps screenshot modes working', async () => {
  const fixture = http.createServer((req, res) => {
    if (req.url === '/asset.svg') {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="8"><rect width="16" height="8" fill="red"/></svg>');
    }
    if (req.url === '/style.css') {
      res.writeHead(200, { 'Content-Type': 'text/css' });
      return res.end('body { background-color: rgb(1, 2, 3); }');
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>UI archive</title><link rel="stylesheet" href="/style.css"><p>embedded page text</p><img src="/asset.svg"><div role="dialog" aria-modal="true">modal presence marker<button aria-label="Close" onclick="this.parentElement.remove()">close</button></div>');
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));

  let service;
  let browser;
  let dir;
  try {
    const portServer = net.createServer();
    await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
    const port = portServer.address().port;
    await new Promise(resolve => portServer.close(resolve));
    service = spawn(process.execPath, [path.join(__dirname, '../shot-server.js')], {
      env: { ...process.env, SHOT_PORT: String(port), BR_HEADLESS: 'true', BR_ADBLOCK: 'false' },
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    service.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const readyUntil = Date.now() + 15000;
    let ready = false;
    while (!ready && Date.now() < readyUntil) {
      if (service.exitCode !== null) throw new Error(`shot-server exited: ${stderr}`);
      try { ready = (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, `shot-server did not start: ${stderr}`);

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ acceptDownloads: true });
    await page.goto(`http://127.0.0.1:${port}`);
    const url = `http://127.0.0.1:${fixture.address().port}`;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-mhtml-ui-'));

    await page.getByRole('button', { name: 'MHTML', exact: true }).click();
    assert.equal(await page.locator('#screenshot-options').isVisible(), false);
    assert.equal(await page.locator('input[name="asIs"]').isChecked(), false);
    await page.locator('#url').fill(url);
    await page.locator('#waitTime').fill('0');
    await page.getByRole('button', { name: 'Capture MHTML Archive' }).click();
    await page.locator('#result-container-mhtml.visible').waitFor();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download MHTML' }).click()
    ]);
    assert.match(download.suggestedFilename(), /^page-.*\.mhtml$/);
    const archivePath = path.join(dir, download.suggestedFilename());
    await download.saveAs(archivePath);
    assert.doesNotMatch(fs.readFileSync(archivePath, 'utf8'), /modal presence marker/);

    await page.getByRole('button', { name: 'MHTML', exact: true }).click();
    await page.locator('#url').fill(url);
    await page.locator('#waitTime').fill('0');
    await page.locator('input[name="asIs"]').check();
    await page.getByRole('button', { name: 'Capture MHTML Archive' }).click();
    await page.locator('#result-container-mhtml.visible').waitFor();
    const [asIsDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download MHTML' }).click()
    ]);
    const asIsPath = path.join(dir, asIsDownload.suggestedFilename());
    await asIsDownload.saveAs(asIsPath);
    assert.match(fs.readFileSync(asIsPath, 'utf8'), /modal presence marker/);

    await page.getByRole('button', { name: 'Single', exact: true }).click();
    await page.locator('#url').fill(url);
    await page.locator('#height').fill('240');
    await page.locator('#waitTime').fill('0');
    await page.getByRole('button', { name: 'Capture Screenshot' }).click();
    await page.locator('#result-container.visible').waitFor();
    assert.ok(await page.locator('#screenshot-img').evaluate(img => img.complete && img.naturalWidth > 0));

    await page.getByRole('button', { name: 'Multi', exact: true }).click();
    await page.locator('#url').fill(url);
    await page.locator('#waitTime').fill('0');
    await page.locator('.output-row [data-field="height"]').first().fill('200');
    await page.getByRole('button', { name: 'Capture Multiple Screenshots' }).click();
    await page.locator('#result-container-multi.visible').waitFor();
    assert.equal(await page.locator('#multi-results img').count(), 1);

    await closeServer(fixture);
    const offline = await browser.newPage();
    await offline.goto(pathToFileURL(archivePath).href, { waitUntil: 'load' });
    assert.equal(await offline.title(), 'UI archive');
    assert.equal(await offline.locator('p').innerText(), 'embedded page text');
    assert.equal(await offline.locator('img').evaluate(img => img.naturalWidth), 16);
    assert.equal(await offline.locator('body').evaluate(body => getComputedStyle(body).backgroundColor), 'rgb(1, 2, 3)');
  } finally {
    await browser?.close();
    if (service && service.exitCode === null) {
      const exited = new Promise(resolve => service.once('exit', resolve));
      service.kill('SIGTERM');
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 10000))]);
      if (service.exitCode === null) service.kill('SIGKILL');
    }
    await closeServer(fixture);
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});
