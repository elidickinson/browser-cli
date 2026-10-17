const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const { spawn } = require('node:child_process');
const net = require('node:net');
const { chromium } = require('patchright');
const { captureMhtml, loadLazyContent } = require('../utils');

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  });
}

function saveArchive(dir, name, data) {
  const archive = path.join(dir, name);
  fs.writeFileSync(archive, data);
  return archive;
}

test('MHTML export embeds page assets and reopens offline', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="8"><rect width="16" height="8" fill="red"/></svg>';
  const server = http.createServer((req, res) => {
    if (req.url === '/asset.svg') {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      res.end(svg);
    } else if (req.url === '/style.css') {
      res.writeHead(200, { 'Content-Type': 'text/css' });
      res.end('body { background-color: rgb(1, 2, 3); }');
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>Offline archive</title><link rel="stylesheet" href="/style.css"><p>embedded page text</p><img src="/asset.svg">');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  let browser;
  let dir;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'load' });
    const mhtml = await captureMhtml(page);
    assert.match(mhtml, /Content-Type: multipart\/related/i);
    assert.match(mhtml, /\/asset\.svg/i);
    assert.match(mhtml, /\/style\.css/i);
    assert.match(mhtml, /<svg xmlns=3D/);
    assert.match(mhtml, /fill=3D"red"/);

    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-mhtml-test-'));
    const archive = path.join(dir, 'page.mhtml');
    fs.writeFileSync(archive, mhtml, 'utf8');
    await new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    });

    const offline = await browser.newPage();
    await offline.goto(pathToFileURL(archive).href, { waitUntil: 'load' });
    assert.equal(await offline.title(), 'Offline archive');
    assert.equal(await offline.locator('p').innerText(), 'embedded page text');
    assert.equal(await offline.locator('img').evaluate(img => img.naturalWidth), 16);
    assert.equal(await offline.locator('body').evaluate(body => getComputedStyle(body).backgroundColor), 'rgb(1, 2, 3)');
  } finally {
    await browser?.close();
    if (server.listening) {
      const closed = new Promise(resolve => server.close(resolve));
      server.closeAllConnections();
      await closed;
    }
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('lazy-content preparation leaves an un-emulated desktop viewport unchanged', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: null });
    const page = await context.newPage();
    await page.setContent('<img loading="lazy">');
    await loadLazyContent(page);
    assert.equal(page.viewportSize(), null);
    assert.equal(await page.locator('img').getAttribute('loading'), 'eager');
  } finally {
    await browser.close();
  }
});

test('lazy-content preparation restores the viewport after a page error', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.setContent('<p>Page content</p>');
    await page.evaluate(() => {
      Object.defineProperty(document, 'images', { get() { throw new Error('Image inspection failed'); } });
    });
    await assert.rejects(loadLazyContent(page), /Image inspection failed/);
    assert.deepEqual(page.viewportSize(), { width: 800, height: 600 });
  } finally {
    await browser.close();
  }
});

test('responsive MHTML preserves the captured srcset candidate across offline viewport/DPR changes', async () => {
  const images = {
    '/fallback.svg': [5, 4, 'green'],
    '/small.svg': [400, 200, 'red'],
    '/large.svg': [1800, 900, 'blue']
  };
  const server = http.createServer((req, res) => {
    if (images[req.url]) {
      const [width, height, color] = images[req.url];
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      return res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${color}"/></svg>`);
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><img id="responsive" src="/fallback.svg" sizes="100vw" srcset="/small.svg 400w, /large.svg 1800w">');
  });
  const baseUrl = await listen(server);
  let browser;
  let dir;
  const contexts = [];
  try {
    browser = await chromium.launch({ headless: true });
    const original = await browser.newContext({ viewport: { width: 900, height: 600 }, deviceScaleFactor: 2 });
    contexts.push(original);
    const page = await original.newPage();
    await page.goto(baseUrl, { waitUntil: 'load' });
    assert.equal(new URL(await page.locator('#responsive').evaluate(img => img.currentSrc)).pathname, '/large.svg');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-responsive-mhtml-'));
    const archive = saveArchive(dir, 'page.mhtml', await captureMhtml(page));
    await closeServer(server);

    // Chromium flattens srcset to its captured candidate; reopening keeps those bytes usable.
    for (const [viewport, dpr] of [
      [{ width: 900, height: 600 }, 2],
      [{ width: 250, height: 300 }, 1]
    ]) {
      const context = await browser.newContext({ viewport, deviceScaleFactor: dpr });
      contexts.push(context);
      await context.setOffline(true);
      const offline = await context.newPage();
      await offline.goto(pathToFileURL(archive).href, { waitUntil: 'load' });
      assert.equal(await offline.locator('#responsive').evaluate(img => img.naturalWidth), 1800);
    }
  } finally {
    await Promise.all(contexts.map(context => context.close()));
    await browser?.close();
    await closeServer(server);
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('lazy picture data-srcset content is embedded offline and lazy preparation restores viewport', async () => {
  const widths = {
    '/placeholder.svg': 7, '/fallback.svg': 9, '/wide-1.svg': 31,
    '/wide-2.svg': 47, '/narrow-1.svg': 19, '/narrow-2.svg': 23
  };
  const server = http.createServer((req, res) => {
    if (widths[req.url]) {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      return res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="${widths[req.url]}" height="13"><rect width="100%" height="100%" fill="red"/></svg>`);
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><div style="height:1400px"></div><picture><source media="(min-width: 600px)" data-srcset="/wide-1.svg 1x, /wide-2.svg 2x"><img id="lazy" loading="lazy" src="/placeholder.svg" data-src="/fallback.svg" data-srcset="/narrow-1.svg 1x, /narrow-2.svg 2x"></picture>');
  });
  const baseUrl = await listen(server);
  let browser;
  let dir;
  const contexts = [];
  try {
    browser = await chromium.launch({ headless: true });
    const original = await browser.newContext({ viewport: { width: 800, height: 450 }, deviceScaleFactor: 2 });
    contexts.push(original);
    const page = await original.newPage();
    await page.goto(baseUrl, { waitUntil: 'load' });
    const viewport = page.viewportSize();
    await loadLazyContent(page);
    assert.deepEqual(page.viewportSize(), viewport);
    assert.equal(new URL(await page.locator('#lazy').evaluate(img => img.currentSrc)).pathname, '/wide-2.svg');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-lazy-mhtml-'));
    const archive = saveArchive(dir, 'page.mhtml', await captureMhtml(page));
    await closeServer(server);

    const offlineContext = await browser.newContext({ viewport, deviceScaleFactor: 2 });
    contexts.push(offlineContext);
    await offlineContext.setOffline(true);
    const offline = await offlineContext.newPage();
    await offline.goto(pathToFileURL(archive).href, { waitUntil: 'load' });
    assert.deepEqual(offline.viewportSize(), viewport);
    assert.equal(new URL(await offline.locator('#lazy').evaluate(img => img.currentSrc)).pathname, '/wide-2.svg');
    assert.equal(await offline.locator('#lazy').evaluate(img => img.naturalWidth), 24);
  } finally {
    await Promise.all(contexts.map(context => context.close()));
    await browser?.close();
    await closeServer(server);
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('MHTML preserves UTF-8 and Windows-1252 HTTP text exactly offline', async () => {
  const documents = {
    '/utf8': {
      header: 'text/html; charset=utf-8',
      body: Buffer.from('<!doctype html><meta charset="utf-8"><p id="text">UTF-8 café — “quotes” €</p>', 'utf8'),
      expected: 'UTF-8 café — “quotes” €'
    },
    '/windows-1252': {
      header: 'text/html; charset=windows-1252',
      body: Buffer.from('<!doctype html><p id="text">Windows caf\xe9 \x97 \x93quotes\x94 \x80</p>', 'latin1'),
      expected: 'Windows café — “quotes” €'
    }
  };
  const server = http.createServer((req, res) => {
    const doc = documents[req.url];
    if (!doc) return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': doc.header });
    res.end(doc.body);
  });
  const baseUrl = await listen(server);
  let browser;
  let dir;
  const contexts = [];
  try {
    browser = await chromium.launch({ headless: true });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-charset-mhtml-'));
    const archives = [];
    for (const [route, doc] of Object.entries(documents)) {
      const context = await browser.newContext();
      contexts.push(context);
      const page = await context.newPage();
      await page.goto(`${baseUrl}${route}`, { waitUntil: 'load' });
      assert.equal(await page.locator('#text').innerText(), doc.expected);
      archives.push([saveArchive(dir, `${route.slice(1)}.mhtml`, await captureMhtml(page)), doc.expected]);
    }
    await closeServer(server);

    for (const [archive, expected] of archives) {
      const context = await browser.newContext();
      contexts.push(context);
      await context.setOffline(true);
      const page = await context.newPage();
      await page.goto(pathToFileURL(archive).href, { waitUntil: 'load' });
      assert.equal(await page.locator('#text').innerText(), expected);
    }
  } finally {
    await Promise.all(contexts.map(context => context.close()));
    await browser?.close();
    await closeServer(server);
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('shot-server returns a downloadable MHTML archive with embedded assets', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="8"><rect width="16" height="8" fill="red"/></svg>';
  const fixture = http.createServer((req, res) => {
    if (req.url === '/asset.svg') {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      return res.end(svg);
    }
    if (req.url === '/style.css') {
      res.writeHead(200, { 'Content-Type': 'text/css' });
      return res.end('body { background-color: rgb(1, 2, 3); }');
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>HTTP MHTML</title><link rel="stylesheet" href="/style.css"><p>embedded page text</p><img src="/asset.svg"><div role="dialog" aria-modal="true">modal presence marker<button aria-label="Close" onclick="this.parentElement.remove()">close</button></div>');
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
      try {
        ready = (await fetch(`http://127.0.0.1:${port}/health`)).ok;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, `shot-server did not start: ${stderr}`);

    const url = `http://127.0.0.1:${fixture.address().port}`;
    const response = await fetch(`http://127.0.0.1:${port}/mhtml`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url })
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /multipart\/related/i);
    assert.match(response.headers.get('content-disposition'), /attachment; filename=".*\.mhtml"/);
    const archive = Buffer.from(await response.arrayBuffer());
    const mhtml = archive.toString('utf8');
    assert.match(mhtml, /\/asset\.svg/i);
    assert.match(mhtml, /\/style\.css/i);
    assert.doesNotMatch(mhtml, /modal presence marker/);

    const asIsResponse = await fetch(`http://127.0.0.1:${port}/mhtml`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, asIs: true })
    });
    assert.equal(asIsResponse.status, 200);
    assert.match(Buffer.from(await asIsResponse.arrayBuffer()).toString('utf8'), /modal presence marker/);

    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-mhtml-http-test-'));
    const archivePath = path.join(dir, 'page.mhtml');
    fs.writeFileSync(archivePath, archive);
    const fixtureClosed = new Promise(resolve => fixture.close(resolve));
    fixture.closeAllConnections();
    await fixtureClosed;

    browser = await chromium.launch({ headless: true });
    const offline = await browser.newPage();
    await offline.goto(pathToFileURL(archivePath).href, { waitUntil: 'load' });
    assert.equal(await offline.title(), 'HTTP MHTML');
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
    if (fixture.listening) {
      const closed = new Promise(resolve => fixture.close(resolve));
      fixture.closeAllConnections();
      await closed;
    }
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});
