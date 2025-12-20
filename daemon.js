const express = require('express');
const { chromium } = require('patchright');
// Patchright has stealth features built-in
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

// Optional ad blocking (off by default)
// Enable with: BR_ADBLOCK=true br start
// Base level: BR_ADBLOCK_BASE=none|adsandtrackers|full|ads
// Additional lists: BR_ADBLOCK_LISTS=https://url1.txt,https://url2.txt
let adblocker = null;

async function initAdblocker() {
  const { PlaywrightBlocker } = require('@ghostery/adblocker-playwright');
  const fetch = require('cross-fetch');

  const base = process.env.BR_ADBLOCK_BASE || 'adsandtrackers';
  const additionalLists = process.env.BR_ADBLOCK_LISTS;

  // Get base blocker
  let blocker;
  switch (base) {
    case 'none':
      blocker = PlaywrightBlocker.empty();
      console.log('Ad blocking enabled (no base filters)');
      break;
    case 'full':
      blocker = await PlaywrightBlocker.fromPrebuiltFull(fetch);
      console.log('Ad blocking enabled (full: ads + tracking + annoyances + cookies)');
      break;
    case 'ads':
      blocker = await PlaywrightBlocker.fromPrebuiltAdsOnly(fetch);
      console.log('Ad blocking enabled (ads only)');
      break;
    case 'adsandtrackers':
    default:
      blocker = await PlaywrightBlocker.fromPrebuiltAdsAndTracking(fetch);
      console.log('Ad blocking enabled (ads + tracking)');
      break;
  }

  // Add additional lists if specified
  if (additionalLists) {
    const customLists = additionalLists.split(',').map(s => s.trim());

    for (const listPath of customLists) {
      let listContent;
      if (listPath.startsWith('http://') || listPath.startsWith('https://')) {
        const response = await fetch(listPath);
        listContent = await response.text();
      } else {
        listContent = fs.readFileSync(listPath, 'utf8');
      }

      const filters = listContent
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.startsWith('!'));

      console.log(`Loaded ${listContent.split('\n').length} lines (${filters.length} active rules) from ${listPath}`);

      blocker.updateFromDiff({ added: filters });

      console.log(`Successfully applied custom list ${listPath}`);
    }
  }

  adblocker = blocker;
}

let lastIdToXPath = {}; // Global variable to store the last idToXPath mapping
const secrets = new Set();
const history = [];

async function detectChallengePage(page) {
  try {
    return await page.evaluate(() => {
      // Cloudflare
      if (document.title === 'Just a moment...' ||
          window._cf_chl_opt ||
          document.querySelector('script[src*="/cdn-cgi/challenge-platform/"]') ||
          (document.querySelector('meta[http-equiv="refresh"]') && document.title.includes('Just a moment'))) {
        return 'cloudflare';
      }

      // SiteGround
      if (document.title === 'Robot Challenge Screen' ||
          window.sgchallenge ||
          Array.from(document.querySelectorAll('script')).some(script =>
            script.textContent.includes('sgchallenge'))) {
        return 'siteground';
      }

      return false;
    });
  } catch (err) {
    return false;
  }
}

async function waitForChallengeBypass(page, maxWaitSeconds = 8) {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitSeconds * 1000) {
    const challenge = await detectChallengePage(page);
    if (!challenge) {
      return true;
    }
    await page.waitForTimeout(100);
  }

  return false;
}

async function setupAdblocking(page) {
  if (!adblocker) return;
  await adblocker.enableBlockingInPage(page);
}

// Automatically dismisses modals and other UI elements
async function dismissModals(page) {

  // blind fire an Escape keypress
  await page.keyboard.press('Escape');

  // look for close buttons to press
  const selectors = [
    '[data-dismiss="modal"]',  // bootstrap
    '[aria-label="Close dialog"]',
    '[aria-label="Close"]',
    '[aria-label="button.close"]',
    '[aria-modal="true"] [aria-label="Close"]',
    '[aria-modal="true"] [title="Close"]',
    '[aria-modal="true"] [data-action="close"]',
    '.popup .close-button',
    '.modal .close',
    'a.close-popup',
    '[role="dialog"] .close-btn',
    '[role="dialog"] .close-button',
    '[role="dialog"] .close',
    '[role="dialog"] [aria-label="Close"]',
    'button[data-testid="close-welcome-modal"]',
    'button.spu-close-popup',
    '#campaign_modal_wrapper #continue_to_site'
  ].join(', ');
  const maxWaitTime = 2500;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitTime) {
    const closeButton = await page.$(selectors);
    if (!closeButton) {
      break;
    }

    if (await closeButton.isVisible().catch(() => false)) {
      await closeButton.click().catch(() => {});
    }

    await page.waitForTimeout(500);
  }
}

function record(action, args = {}) {
  history.push({ action, args, timestamp: new Date().toISOString() });
}

function humanDelay(minMs, maxMs) {
  if (process.env.BR_HUMANLIKE !== 'true') return Promise.resolve();
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise(r => setTimeout(r, delay));
}

const tmpUserDataDir = path.join(os.tmpdir(), `br_user_data_${Date.now()}`);

(async () => {
  // Initialize adblocker if enabled
  if (process.env.BR_ADBLOCK === 'true') {
    await initAdblocker();
  }
  // Set viewport size for headless mode
  let viewport = null;
  if (process.env.BR_HEADLESS === 'true') {
    const width = parseInt(process.env.BR_VIEWPORT_WIDTH || '1280', 10);
    const height = parseInt(process.env.BR_VIEWPORT_HEIGHT || '720', 10);
    viewport = { width, height };
  }

  let context, browser;
  context = await chromium.launchPersistentContext(tmpUserDataDir, {
    headless: process.env.BR_HEADLESS === 'true',
    viewport
  });
  browser = await context.browser();

  let pages = [];
  let activePage;

  const initialPage = await context.newPage();
  pages.push(initialPage);
  activePage = initialPage;
  await setupAdblocking(initialPage);

  function getActivePage() {
    return activePage;
  }

  context.on('page', async newPage => {
    pages = await context.pages();
    activePage = newPage;
    await setupAdblocking(newPage);
  });

  context.on('framenavigated', async frame => {
    if (frame === activePage.mainFrame()) {
      // The active page's main frame navigated, update activePage to ensure it's still the correct reference
      // This is a safeguard, as Playwright's page object should remain consistent across navigations
      // but it helps to re-confirm the active page in case of complex scenarios.
      activePage = frame.page();
    }
  });

  let shuttingDown = false;

  context.on('close', () => {
    if (!shuttingDown) {
      console.log('Browser context closed. This may cause subsequent requests to fail.');
    }
  });

  browser.on('disconnected', () => {
    if (!shuttingDown) {
      console.log('Browser disconnected. Exiting daemon.');
      process.exit(0);
    }
  });

  // Listen for page close events
  context.on('pageclose', closedPage => {
    pages = pages.filter(page => page !== closedPage);
    if (activePage === closedPage) {
      // If the active page was closed, switch to the last remaining page or null if no pages left
      activePage = pages.length > 0 ? pages[pages.length - 1] : null;
    }
  });

  const app = express();

  // Add request logging middleware
  app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
  });

  app.use(express.json());

  // Serve static files
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/health', (req, res) => {
    res.send('ok');
  });

  app.get('/tabs', async (req, res) => {
    try {
      const tabInfo = await Promise.all(pages.map(async (p, i) => ({
        index: i,
        title: await p.title(),
        url: p.url(),
        isActive: p === activePage
      })));
      res.json(tabInfo);
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  app.post('/tabs/switch', (req, res) => {
    const { index } = req.body;
    if (index === undefined || index < 0 || index >= pages.length) {
      return res.status(400).send('invalid tab index');
    }
    activePage = pages[index];
    record('switch-tab', { index });
    res.send('ok');
  });

  app.post('/goto', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).send('missing url');
    try {
      await humanDelay(200, 400);
      await getActivePage().goto(url, {
        timeout: 30000,
        waitUntil: 'domcontentloaded'
      });
      await humanDelay(200, 400);
      record('goto', { url });
      res.send('ok');
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  async function resolveSelector(page, selector) {
  let element;
  let actualSelector = selector;

  // Handle numeric IDs from view-tree
  if (!isNaN(selector) && !isNaN(parseFloat(selector))) {
    const xpath = lastIdToXPath[selector];
    if (!xpath) throw new Error(`XPath not found for ID: ${selector}`);
    element = await page.$(xpath);
    actualSelector = xpath;
  } else {
    // Handle CSS selectors and XPath expressions
    element = await page.$(selector);
  }

  if (!element) {
    throw new Error(`Element not found for selector: ${selector}`);
  }

  return { element, actualSelector };
}

async function resolveAndPerformAction(req, res, actionFn, recordAction, recordArgs = {}) {
    let { selector } = req.body;
    if (!selector) return res.status(400).send('missing selector');

    try {
      let element;
      let actualSelector = selector;

      // Handle numeric IDs from view-tree
      if (!isNaN(selector) && !isNaN(parseFloat(selector))) {
        const xpath = lastIdToXPath[selector];
        if (!xpath) return res.status(400).send('XPath not found for ID');
        element = await getActivePage().$(xpath);
        actualSelector = xpath; // Use XPath for action
      } else {
        // Handle CSS selectors and XPath expressions
        if (selector.startsWith('xpath=')) {
          // XPath expression
          element = await getActivePage().$(selector);
        } else {
          // CSS selector
          element = await getActivePage().$(selector);
        }
      }

      if (!element) {
        return res.status(400).send(`Element not found for selector: ${selector}`);
      }
      await actionFn(actualSelector);
      record(recordAction, { selector, ...recordArgs });
      res.send('ok');
    } catch (err) {
      res.status(500).send(`Error when action: ${err.message}

Use CSS selectors (e.g., "input"), XPath (e.g., "xpath=//input"), or numeric IDs from view-tree`);
    }
  }

  app.post('/scroll-into-view', async (req, res) => {
    await resolveAndPerformAction(req, res, async (selector) => {
      await getActivePage().evaluate(sel => {
        const el = document.querySelector(sel);
        if (el) el.scrollIntoView();
      }, selector);
    }, 'scrollIntoView');
  });

  app.post('/scroll-to', async (req, res) => {
    let { percentage } = req.body;
    if (percentage === undefined) return res.status(400).send('missing percentage');
    percentage = Math.max(0, Math.min(100, Number(percentage)));
    try {
      await getActivePage().evaluate(pct => {
        window.scrollTo(0, document.body.scrollHeight * (pct / 100));
      }, percentage);
      record('scrollTo', { percentage });
      res.send('ok');
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  app.post('/fill', async (req, res) => {
    const { text } = req.body;
    if (text === undefined) return res.status(400).send('missing text');
    await resolveAndPerformAction(req, res, async (selector) => {
      await getActivePage().fill(selector, text);
    }, 'fill', { text });
  });

  app.post('/fill-secret', async (req, res) => {
    const { secret } = req.body;
    if (secret === undefined) return res.status(400).send('missing secret');
    await resolveAndPerformAction(req, res, async (selector) => {
      await getActivePage().fill(selector, secret);
      secrets.add(secret);
    }, 'fill-secret');
  });

  app.post('/type', async (req, res) => {
    const { text } = req.body;
    if (text === undefined) return res.status(400).send('missing text');
    await resolveAndPerformAction(req, res, async (selector) => {
      if (process.env.BR_HUMANLIKE === 'true') {
        for (const char of text) {
          await getActivePage().type(selector, char);
          await humanDelay(30, 80);
        }
      } else {
        await getActivePage().type(selector, text);
      }
    }, 'type', { text });
  });

  app.post('/press', async (req, res) => {
    const { key } = req.body;
    if (!key) return res.status(400).send('missing key');
    try {
      await getActivePage().keyboard.press(key);
      record('press', { key });
      res.send('ok');
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  app.post('/fill-search', async (req, res) => {
    const { query, selector } = req.body;
    if (!query || !query.trim()) return res.status(400).send('missing query');

    try {
      let searchInput;
      let foundSelector = null;

      if (selector) {
        // Use explicit selector if provided
        const { element, actualSelector } = await resolveSelector(getActivePage(), selector);
        searchInput = element;
        foundSelector = actualSelector;
      } else {
        // Smart search input detection
        const searchSelectors = [
          'input[type="search"]',
          'input[name="q"]',
          'input[name="query"]',
          'input[name="search"]',
          'input[placeholder*="search" i]',
          '[role="searchbox"]',
          'input[placeholder*="Search" i]'
        ];

        for (const sel of searchSelectors) {
          const element = await getActivePage().$(sel);
          if (element) {
            searchInput = element;
            foundSelector = sel;
            break;
          }
        }

        if (!searchInput) {
          return res.status(400).send('No search input found. Try again with --selector to specify the exact search input.');
        }
      }

      await humanDelay(50, 150);
      await searchInput.fill(query);
      await humanDelay(50, 150);
      await getActivePage().keyboard.press('Enter');

      record('search', { query, selector: foundSelector });
      res.json({ status: 'ok', selector: foundSelector });
    } catch (err) {
      res.status(500).send(`Search error: ${err.message}

Try using --selector to specify the search input explicitly.`);
    }
  });

  app.post('/next-chunk', async (req, res) => {
    try {
      await getActivePage().evaluate(() => {
        window.scrollBy(0, window.innerHeight);
      });
      record('next-chunk');
      res.send('ok');
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  app.post('/prev-chunk', async (req, res) => {
    try {
      await getActivePage().evaluate(() => {
        window.scrollBy(0, -window.innerHeight);
      });
      record('prev-chunk');
      res.send('ok');
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  app.post('/click', async (req, res) => {
    await resolveAndPerformAction(req, res, async (selector) => {
      await humanDelay(50, 150);
      await getActivePage().click(selector);
    }, 'click');
  });

  app.get('/screenshot', async (req, res) => {
    try {
      const dir = path.join(os.tmpdir(), 'br_cli');
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      let file;
      if (req.query.path) {
        // Use custom path, resolve relative paths against current directory
        file = path.resolve(req.query.path);
      } else {
        // Generate default filename with domain
        const url = new URL(getActivePage().url());
        const domain = url.hostname.replace(/[^a-zA-Z0-9.-]/g, '');
        file = path.join(dir, `shot-${domain}-${Date.now()}.png`);
      }

      const fullPage = req.query.fullPage === 'true';
      await getActivePage().screenshot({ path: file, fullPage });
      record('screenshot', { fullPage, path: file });
      res.send(file);
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  app.get('/html', async (req, res) => {
    try {
      let html = await getActivePage().content();
      for (const secret of secrets) {
        if (!secret) continue;
        html = html.split(secret).join('***');
      }
      res.send(html);
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  app.get('/history', (req, res) => {
    res.json(history);
  });

  app.post('/history/clear', (req, res) => {
    history.length = 0;
    res.send('ok');
  });

  app.get('/tree', async (req, res) => {
    try {
      const page = getActivePage();
      const session = await page.context().newCDPSession(page);
      await session.send('DOM.enable');
      await session.send('Accessibility.enable');

      const { nodes: axNodes } = await session.send('Accessibility.getFullAXTree');
      const { root: domRoot } = await session.send('DOM.getDocument', { depth: -1, pierce: true });
      await session.detach();

      const nodeIdToDomNodeMap = new Map();
      const backendIdToDomNodeMap = new Map();
      let idToXPath = {};

      function generateXPath(node, parentNode) {
        if (!node || node.nodeName === '#document') {
          return '';
        }

        const tagName = node.nodeName.toLowerCase();
        let segment = tagName;

        if (parentNode && parentNode.children) {
          const siblings = parentNode.children.filter(child => child.nodeName === node.nodeName);
          if (siblings.length > 1) {
            const index = siblings.indexOf(node) + 1;
            segment += `[${index}]`;
          }
        }
        return segment;
      }

      function traverseDomAndMap(node, parentXPath = '', parentNode = null) {
        if (!node) return;

        nodeIdToDomNodeMap.set(node.nodeId, node);
        backendIdToDomNodeMap.set(node.backendNodeId, node);

        const currentSegment = generateXPath(node, parentNode);
        const currentXPath = parentXPath ? `${parentXPath}/${currentSegment}` : `/${currentSegment}`;

        if (node.nodeId) {
          idToXPath[node.nodeId] = currentXPath;
        }

        if (node.children) {
          for (const child of node.children) {
            traverseDomAndMap(child, currentXPath, node);
          }
        }
      }

      traverseDomAndMap(domRoot);

      const axMap = new Map();
      const childSet = new Set();
      for (const node of axNodes) {
        axMap.set(node.nodeId, node);
        for (const childId of node.childIds || []) childSet.add(childId);
      }
      const rootAx = axNodes.find(n => !childSet.has(n.nodeId)) || axNodes[0];

      function buildTree(nodeId) {
        const axNode = axMap.get(nodeId);
        if (!axNode) return null;

        const domNode = backendIdToDomNodeMap.get(axNode.backendDOMNodeId);
        const role = axNode.role?.value || '';
        const name = axNode.name?.value || '';
        const tag = domNode ? domNode.nodeName.toLowerCase() : null;

        // Store xpath mapping for this node
        if (domNode && domNode.nodeId) {
          idToXPath[axNode.nodeId] = idToXPath[domNode.nodeId];
        }

        const node = {
          id: axNode.nodeId,
          role: role,
          name: name || null,
          tag: tag ? `<${tag}>` : null,
          xpath: idToXPath[axNode.nodeId] || null,
          children: []
        };

        // Recursively build children
        for (const childId of axNode.childIds || []) {
          const childNode = buildTree(childId);
          if (childNode) {
            node.children.push(childNode);
          }
        }

        return node;
      }

      const tree = buildTree(rootAx.nodeId);
      lastIdToXPath = idToXPath; // Store the mapping globally
      res.json({ tree });
    } catch (err) {
      res.status(500).send(err.message + " " + err.stack);
    }
  });

  app.post('/xpath-for-id', (req, res) => {
    const { id } = req.body;
    if (id === undefined) return res.status(400).send('missing id');
    const xpath = lastIdToXPath[id];
    if (!xpath) return res.status(400).send('XPath not found for ID');
    res.json({ xpath });
  });

  app.post('/eval', async (req, res) => {
    const { script } = req.body;
    if (!script) return res.status(400).send('missing script');
    try {
      const result = await getActivePage().evaluate((scriptToRun) => {
        return eval(scriptToRun);
      }, script);
      record('eval', { script });
      // Return result as JSON to handle various types (undefined, null, objects, primitives)
      res.json({ result });
    } catch (err) {
      res.status(500).send(`Error evaluating script: ${err.message}`);
    }
  });

  app.post('/extract-text', async (req, res) => {
    let page;
    try {
      page = await browser.getPage();
      const { selector } = req.body;

      let resolvedSelector = null;
      let response = { text: '' };

      if (selector) {
        resolvedSelector = resolveSelector(selector);
        if (!resolvedSelector) {
          return res.status(400).send('Invalid selector');
        }
        response.selector = resolvedSelector;
      }

      const text = await page.evaluate((sel, maxElements = 1000, timeout = 5000) => {
        const startTime = Date.now();

        if (sel) {
          const elements = Array.from(document.querySelectorAll(sel));
          if (elements.length > maxElements) {
            throw new Error(`Too many elements found (${elements.length} > ${maxElements})`);
          }

          if (Date.now() - startTime > timeout) {
            throw new Error('Timeout during extraction');
          }

          return elements.map((el, index) => {
            const text = el.innerText || '';
            return `[Element ${index + 1}]\n${text}`;
          }).join('\n\n---\n\n');
        } else {
          const scripts = document.querySelectorAll('script, style, noscript');
          scripts.forEach(el => el.remove());

          const hiddenElements = document.querySelectorAll('[style*="display:none"], [style*="visibility:hidden"], [style*="opacity:0"]');
          hiddenElements.forEach(el => el.remove());

          if (Date.now() - startTime > timeout) {
            throw new Error('Timeout during extraction');
          }

          return document.body.innerText || '';
        }
      }, resolvedSelector);

      response.text = text || 'No text found';
      res.json(response);

    } catch (err) {
      res.status(500).send(`Error extracting text: ${err.message}`);
    }
  });

  app.post('/shot', async (req, res) => {
    let page;
    try {
      const {
        url,
        width,
        height,
        waitTime,
        output_width,
        output_format,
        output_quality
      } = req.body;

      if (!url) {
        return res.status(400).json({ error: 'missing url parameter' });
      }

      // Prepend https:// if no protocol is specified
      let processedUrl = url;
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        processedUrl = `https://${url}`;
      }

      // Create a new page for the screenshot
      page = await context.newPage();
      await setupAdblocking(page);

      // Set viewport size if width and height are provided
      if (width || height) {
        const viewportWidth = width ? parseInt(width, 10) : 1280;
        const viewportHeight = height ? parseInt(height, 10) : 720;
        await page.setViewportSize({ width: viewportWidth, height: viewportHeight });
      }

      // Navigate to the URL and wait for it to load
      await page.goto(processedUrl, { timeout: 20000 });

      // Wait for challenge pages to complete before screenshotting
      await waitForChallengeBypass(page);

      // Add style to hide scrollbars for cleaner screenshots
      await page.addStyleTag({
        content: `
          /* WebKit scrollbar hiding (Chrome, Safari) */
          ::-webkit-scrollbar { display: none; }

          /* Firefox */
          html { scrollbar-width: none; }

          /* IE and Edge */
          html { -ms-overflow-style: none; }
        `
      });

      // Wait additional time if specified (default: 1000ms)
      const additionalWait = waitTime ? parseInt(waitTime, 10) : 1000;
      await page.waitForTimeout(additionalWait);

      // dismiss any modals not caught by adblock
      await dismissModals(getActivePage());

      // Take screenshot to buffer
      const isFullPage = !height; // Full page if height not provided
      const screenshotBuffer = await page.screenshot({
        fullPage: isFullPage,
        type: 'png'
      });

      record('api-shot', { url, width, height, fullPage: isFullPage, waitTime: additionalWait });

      // Apply output transformations if specified
      let processedBuffer = screenshotBuffer;
      const format = output_format || 'png';
      const quality = output_quality ? parseInt(output_quality, 10) : 80;

      // Create sharp processor
      let processor = sharp(screenshotBuffer);

      // Resize if output_width is specified
      if (output_width) {
        const outputWidth = parseInt(output_width, 10);
        processor = processor.resize(outputWidth, null, {
          withoutEnlargement: true
        });
      }

      // Convert to the requested format
      if (format === 'webp') {
        processor = processor.webp({ quality });
        processedBuffer = await processor.toBuffer();
        res.setHeader('Content-Type', 'image/webp');
      } else if (format === 'jpeg' || format === 'jpg') {
        processor = processor.jpeg({ quality });
        processedBuffer = await processor.toBuffer();
        res.setHeader('Content-Type', 'image/jpeg');
      } else {
        // Default to PNG
        res.setHeader('Content-Type', 'image/png');
      }

      res.setHeader('Content-Length', processedBuffer.length);
      res.send(processedBuffer);

    } catch (err) {
      res.status(500).json({ error: `Error capturing screenshot: ${err.message}` });
    } finally {
      // Close the page if it was created
      if (page) {
        await page.close();
      }
    }
  });

  // API endpoint for serving the web interface
  app.get('/', (req, res) => {
    let html = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8');



    res.send(html);
  });

  const port = 3030;
  app.listen(port, () => {
    console.log(`br daemon running on port ${port}`);
    process.stdout.uncork();
  });

  async function shutdown() {
    shuttingDown = true;
    await context.close();
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  process.on('uncaughtException', (err) => {
    if (err.code === 'EPIPE') {
      // Silently ignore EPIPE errors from closed stdout
      return;
    }
    console.error('Uncaught Exception:', err);
    process.exit(1);
  });
})().catch(err => {
  console.error('daemon error:', err);
  process.exit(1);
});
