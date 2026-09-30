async function detectChallengePage(page) {
  try {
    return await page.evaluate(() => {
      const title = document.title || '';
      const text = document.body ? document.body.innerText.trim() : '';

      // Wall page titles are unique full strings; only exact matches here so real
      // pages with similar words in a headline are never scooped up.
      if (title === 'Just a moment...' || title === 'Attention Required! | Cloudflare') {
        return 'cloudflare';
      }
      if (title === 'Robot Challenge Screen') {
        return 'siteground';
      }
      if (title.startsWith('Sucuri WebSite Firewall')) {
        return 'sucuri';
      }

      // Vendor challenge runtimes. A full-content page can load /cdn-cgi/
      // challenge-platform in non-blocking mode while showing real content, so
      // only count it as a wall on a near-empty page. _cf_chl_opt exists only on
      // the Cloudflare wall itself.
      if (window._cf_chl_opt) {
        return 'cloudflare';
      }
      if (text.length < 500 &&
          document.querySelector('script[src*="/cdn-cgi/challenge-platform/"]')) {
        return 'cloudflare';
      }
      if (window.sgchallenge) {
        return 'siteground';
      }
      if (text.length < 500 &&
          document.querySelector('script[src*="/_Incapsula_Resource"]')) {
        return 'imperva';
      }

      // Interstitial copy: matched whole, near the very top of a short, otherwise empty page.
      // Long article quotes sit further down the text and can't reach the first 80 chars.
      const top = text.slice(0, 80);
      const shortInterstitial = text.length < 300 &&
        (/(this website is using a security service to protect itself from online attacks\.)/i.test(top) ||
         /please stand by while we (are )?(checking|verifying) your browser/i.test(top) ||
         /this process is automatic\./i.test(top) ||
         /checking your browser before accessing/i.test(top));
      if (shortInterstitial) {
        return 'interstitial';
      }

      // A visible captcha widget plus a short "confirm you are human" page is a bot wall.
      // Real pages never embed a captcha, so this needs both signals together.
      const hasCaptchaWidget = document.querySelector(
        'iframe[src*="hcaptcha"], iframe[src*="recaptcha"], iframe[src*="turnstile"], iframe[src*="challenges.cloudflare.com"]'
      );
      if (hasCaptchaWidget && text.length < 300 && /verify you are human|confirm you are human/i.test(top)) {
        return 'interstitial';
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
    '.close-footer-btn'
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

async function isBlankScreenshot(buffer) {
  // sharp is an optional dependency, so require it only when analyzing a screenshot
  const sharp = require('sharp');
  const { entropy, channels } = await sharp(buffer).stats();
  const maxStdev = Math.max(...channels.map(channel => channel.stdev));
  return entropy < 0.5 && maxStdev < 5;
}

module.exports = {
  detectChallengePage,
  waitForChallengeBypass,
  dismissModals,
  initAdblocker,
  isBlankScreenshot
};
