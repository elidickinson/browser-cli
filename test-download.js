#!/usr/bin/env node

/**
 * Integration test for the download command.
 *
 * Usage: BR_PORT=3030 node test-download.js
 *   (assumes a br daemon is already running on that port)
 *
 * Tests:
 *  1. Download via CSS selector (element with href)
 *  2. Download via direct URL
 *  3. Error case: selector with no href/src
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.BR_PORT) || 3030;
const BASE = `http://localhost:${PORT}`;

let passed = 0;
let failed = 0;

function post(endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(`${BASE}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        let parsed;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function assert(condition, label) {
  if (condition) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.error(`  FAIL: ${label}`);
    failed++;
  }
}

async function run() {
  // Navigate to a data-URL page with a download link and a span (no href/src)
  const testPage = `data:text/html,${encodeURIComponent(`<!DOCTYPE html>
<html><body>
  <a id="dl-link" href="data:text/plain;base64,SGVsbG8gV29ybGQ=">Download</a>
  <span id="no-href">Just text</span>
</body></html>`)}`;

  console.log('Navigating to test page...');
  await post('/goto', { url: testPage });

  // --- Test 1: Download via CSS selector ---
  console.log('\nTest 1: Download via CSS selector');
  const r1 = await post('/download', { selector: '#dl-link' });
  assert(r1.status === 200, `Status 200 (got ${r1.status})`);
  assert(typeof r1.body.path === 'string', `Response has path`);
  assert(r1.body.size === 11, `File size is 11 bytes (got ${r1.body.size})`);
  if (r1.body.path) {
    const content = fs.readFileSync(r1.body.path, 'utf-8');
    assert(content === 'Hello World', `File content is "Hello World" (got "${content}")`);
    fs.unlinkSync(r1.body.path);
  }

  // --- Test 2: Download via direct URL ---
  console.log('\nTest 2: Download via direct URL');
  const directUrl = 'data:text/plain;base64,RGlyZWN0VVJM';
  const r2 = await post('/download', { selector: directUrl });
  assert(r2.status === 200, `Status 200 (got ${r2.status})`);
  assert(r2.body.size === 9, `File size is 9 bytes (got ${r2.body.size})`);
  if (r2.body.path) {
    const content = fs.readFileSync(r2.body.path, 'utf-8');
    assert(content === 'DirectURL', `File content is "DirectURL" (got "${content}")`);
    fs.unlinkSync(r2.body.path);
  }

  // --- Test 3: Error – element with no href or src ---
  console.log('\nTest 3: Element with no href/src');
  const r3 = await post('/download', { selector: '#no-href' });
  assert(r3.status === 400, `Status 400 (got ${r3.status})`);
  assert(typeof r3.body === 'string' && r3.body.includes('no href or src'), `Error mentions missing attribute`);

  // --- Summary ---
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
