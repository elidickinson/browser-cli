const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
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

async function startShotServer() {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));

  const service = spawn(process.execPath, [path.join(__dirname, '../shot-server.js')], {
    env: { ...process.env, SHOT_PORT: String(port), BR_HEADLESS: 'true', BR_ADBLOCK: 'false' },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  service.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (service.exitCode !== null) throw new Error(`shot-server exited: ${stderr}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return { service, port };
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`shot-server did not start: ${stderr}`);
}

async function stopShotServer(service) {
  service.kill();
  await Promise.race([
    new Promise(resolve => service.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 10000).unref())
  ]);
}

test('shot endpoints report the status and URL of the page that ends up on screen', async () => {
  const fixture = http.createServer((req, res) => {
    const body = text => `<!doctype html><title>${text}</title><body style="margin:0;font:24px sans-serif"><div style="background:#222;color:#fff;padding:60px">${text}</div><p>${text}</p></body>`;
    if (req.url === '/js-redirect') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<!doctype html><title>Moved</title><script>location.replace("/gone")</script><body>moving on</body>');
    }
    if (req.url === '/late-redirect') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<!doctype html><title>Loading</title><script>setTimeout(() => location.replace("/gone"), 1500)</script><body>loading</body>');
    }
    if (req.url === '/http-redirect') {
      res.writeHead(302, { Location: '/missing' });
      return res.end();
    }
    if (req.url === '/gone') {
      res.writeHead(410, { 'Content-Type': 'text/html' });
      return res.end(body('this page is gone'));
    }
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end(body('this page does not exist'));
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));

  let service;
  try {
    const server = await startShotServer();
    service = server.service;
    const origin = `http://127.0.0.1:${fixture.address().port}`;

    const shot = await fetch(`http://127.0.0.1:${server.port}/shot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `${origin}/js-redirect`, waitTime: 0 })
    });
    assert.equal(shot.status, 200);
    assert.equal(shot.headers.get('x-page-status'), '410');
    assert.equal(shot.headers.get('x-final-url'), `${origin}/gone`);
    assert.ok((await shot.arrayBuffer()).byteLength > 0);

    const html = await fetch(`http://127.0.0.1:${server.port}/html`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `${origin}/js-redirect`, waitTime: 0 })
    });
    assert.equal(html.status, 200);
    assert.equal(html.headers.get('x-page-status'), '410');
    assert.equal(html.headers.get('x-final-url'), `${origin}/gone`);
    assert.match(await html.text(), /this page is gone/);

    const lateHtml = await fetch(`http://127.0.0.1:${server.port}/html`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `${origin}/late-redirect`, waitTime: 0 })
    });
    assert.equal(lateHtml.status, 200, await lateHtml.clone().text());
    assert.equal(lateHtml.headers.get('x-final-url'), `${origin}/gone`);
    assert.match(await lateHtml.text(), /this page is gone/);

    const multi = await fetch(`http://127.0.0.1:${server.port}/shot-multi`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `${origin}/http-redirect`, waitTime: 0, outputs: [{ height: 200 }] })
    });
    assert.equal(multi.status, 200);
    const multiBody = await multi.json();
    assert.equal(multiBody.page_status, 404);
    assert.equal(multiBody.final_url, `${origin}/missing`);
  } finally {
    if (service) await stopShotServer(service);
    await new Promise(resolve => {
      fixture.close(resolve);
      fixture.closeAllConnections();
    });
  }
});
