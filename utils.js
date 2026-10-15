async function navigateForScreenshot(page, url) {
  return page.goto(url, { timeout: 20000, waitUntil: 'domcontentloaded' });
}

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

// Clicks the Turnstile checkbox if the widget is showing; returns whether it clicked
async function clickTurnstile(page) {
  const frame = page.frames().find(f => f.url().includes('challenges.cloudflare.com'));
  // The frame can detach mid-check when the challenge passes and the page navigates
  const box = frame && await frame.frameElement().then(el => el.boundingBox()).catch(() => null);
  if (!(box?.width > 100)) return false;
  const jitter = n => (Math.random() * 2 - 1) * n;
  await page.mouse.move(box.x + 150 + jitter(100), box.y + 120 + jitter(40), { steps: 8 });
  // Checkbox sits at the left edge of the widget
  await page.mouse.click(box.x + 28 + jitter(4), box.y + box.height / 2 + jitter(4), { delay: 50 + Math.random() * 100 });
  return true;
}

async function waitForChallengeBypass(page, maxWaitSeconds = 20) {
  const startTime = Date.now();
  let lastClick = 0;

  while (Date.now() - startTime < maxWaitSeconds * 1000) {
    const challenge = await detectChallengePage(page);
    if (!challenge) {
      return true;
    }
    // The first click often only resets the widget, so retry every few seconds
    if (challenge === 'cloudflare' && Date.now() - lastClick > 3000 && await clickTurnstile(page)) {
      lastClick = Date.now();
    }
    await page.waitForTimeout(100);
  }

  return false;
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
    '#campaign_modal_wrapper #continue_to_site',
    '.close-footer-btn',
    '.subscriber-dismiss',
    '.fancybox-opened a.fancybox-close',
    '.mfp-wrap button.mfp-close',
    'button[aria-label="Decline cookies"]'
  ].join(', ');
  const maxWaitTime = 2500;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitTime) {
    if (!await page.$(selectors)) {
      break;
    }

    // Sites often keep hidden modals in the DOM, so skip to the first visible match
    const closeButton = page.locator(selectors).filter({ visible: true }).first();
    if (await closeButton.count()) {
      await closeButton.click({ timeout: 1000 }).catch(() => {});
    }

    await page.waitForTimeout(500);
  }
}

async function initAdblocker() {
  const { PlaywrightBlocker } = require('@ghostery/adblocker-playwright');
  const fetch = require('cross-fetch');
  const fs = require('fs');

  const base = process.env.BR_ADBLOCK_BASE || 'adsandtrackers';
  const additionalLists = process.env.BR_ADBLOCK_LISTS;

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

  return blocker;
}

// Briefly make the viewport taller than the page so every lazy loader treats its content as
// visible, then restore it so vh units and resize handlers settle before a fullPage capture.
// See eli/tall-screenshots-lazy-load.md
async function loadLazyContent(page) {
  // Native lazy loading and data-src style JS loaders don't need the resize, and full-screen vh
  // sections can push their images below even a 10000px viewport
  await page.evaluate(() => {
    document.querySelectorAll('[loading="lazy"]').forEach(el => { el.loading = 'eager'; });
    document.querySelectorAll('img[data-src]:not([data-src=""])').forEach(img => { img.src = img.dataset.src; });
    document.querySelectorAll('img[data-srcset]:not([data-srcset=""]), source[data-srcset]:not([data-srcset=""])')
      .forEach(el => { el.srcset = el.dataset.srcset; });
  });

  const viewport = page.viewportSize();
  const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: viewport.width, height: Math.max(pageHeight, 10000) });
  await page.waitForTimeout(500);

  const start = Date.now();
  while (Date.now() - start < 5000) {
    if (await page.evaluate(() => [...document.images].every(img => img.complete))) break;
    await page.waitForTimeout(100);
  }

  await page.setViewportSize(viewport);
  await page.waitForTimeout(500);
}

module.exports = {
  navigateForScreenshot,
  detectChallengePage,
  waitForChallengeBypass,
  dismissModals,
  initAdblocker,
  loadLazyContent
};
