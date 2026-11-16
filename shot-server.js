const express = require('express');
const { chromium } = require('patchright');
const sharp = require('sharp');
const path = require('path');
const {
  waitForChallengeBypass, dismissModals, initAdblocker, loadLazyContent, navigateForScreenshot, captureMhtml,
  isBlankScreenshot, detectChallengePage
} = require('./utils');

// Challenge pages and blank pages are not usable screenshots: report them as 409 so
// callers can keep their last good capture instead of storing the bad image.
async function screenshotProblem(page, buffer) {
  const challenge = await detectChallengePage(page);
  if (challenge) return `challenge: ${challenge}`;
  if (await isBlankScreenshot(buffer)) return 'blank screenshot';
  return null;
}

// HTTP status of the document on screen. goto's response goes stale after JS redirects and
// challenge reloads, and network responses include navigations that never commit (204s,
// downloads). patchright evaluates in an isolated world, so page scripts can't spoof this.
async function pageStatus(page) {
  const status = await page.evaluate(() => performance.getEntriesByType('navigation')[0]?.responseStatus);
  if (!status) throw new Error('page has no navigation response status');
  return status;
}

const PORT = process.env.SHOT_PORT || 3031;
// Well past the built-in waits (navigation, challenge, modals, lazy loading, screenshot) plus waitTime
const REQUEST_TIMEOUT_MS = 120000;

(async () => {
  let adblocker = null;
  if (process.env.BR_ADBLOCK === 'true') {
    adblocker = await initAdblocker();
  }

  const browser = await chromium.launch({ headless: process.env.BR_HEADLESS !== 'false' });
  const onBrowserDisconnected = () => {
    console.error('Browser disconnected; exiting so the service manager can restart');
    process.exit(1);
  };
  browser.on('disconnected', onBrowserDisconnected);

  // Page calls like evaluate have no timeout, so a page that pegs its main thread would hang a
  // request forever. Closing an overrunning context makes the stuck call reject so the request
  // can finish. If Chrome can't open or close a context, it's wedged: exit so we get restarted.
  async function newContext() {
    let context;
    let timer = setTimeout(() => {
      timer = setTimeout(() => {
        console.error('Chrome did not close a timed-out context; exiting so the service manager can restart');
        process.exit(1);
      }, 10000);
      context?.close({ reason: `Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s` });
    }, REQUEST_TIMEOUT_MS);
    context = await browser.newContext();
    context.on('close', () => clearTimeout(timer));
    return context;
  }

  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/health', (req, res) => res.send('ok'));

  app.post('/shot', async (req, res) => {
    let context;
    try {
      const { url, width, height, waitTime, output_width, output_format, output_quality } = req.body;

      if (!url) return res.status(400).json({ error: 'missing url parameter' });

      let processedUrl = url;
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        processedUrl = `https://${url}`;
      }

      context = await newContext();
      const page = await context.newPage();
      if (adblocker) await adblocker.enableBlockingInPage(page);

      if (width || height) {
        const viewportWidth = width ? parseInt(width, 10) : 1280;
        const viewportHeight = height ? parseInt(height, 10) : 720;
        await page.setViewportSize({ width: viewportWidth, height: viewportHeight });
      }

      await navigateForScreenshot(page, processedUrl);
      await waitForChallengeBypass(page);

      await page.addStyleTag({
        content: `
          ::-webkit-scrollbar { display: none; }
          html { scrollbar-width: none; }
          html { -ms-overflow-style: none; }
        `
      });

      const additionalWait = waitTime == null ? 1000 : parseInt(waitTime, 10);
      await page.waitForTimeout(additionalWait);
      await dismissModals(page);

      const isFullPage = !height;
      if (isFullPage) {
        // Catch late popups; loadLazyContent's waits give any close animation time to finish
        await page.keyboard.press('Escape');
        await loadLazyContent(page);
      }
      const screenshotBuffer = await page.screenshot({ fullPage: isFullPage, type: 'png' });

      // Set before the challenge/blank check so 409 responses carry the status too
      res.setHeader('X-Page-Status', await pageStatus(page));

      const problem = await screenshotProblem(page, screenshotBuffer);
      if (problem) return res.status(409).json({ error: problem });

      const format = output_format || 'png';
      const quality = output_quality ? parseInt(output_quality, 10) : 80;

      let processor = sharp(screenshotBuffer);

      if (output_width) {
        processor = processor.resize(parseInt(output_width, 10), null, { withoutEnlargement: true });
      }

      let processedBuffer;
      if (format === 'webp') {
        processedBuffer = await processor.webp({ quality }).toBuffer();
        res.setHeader('Content-Type', 'image/webp');
      } else if (format === 'jpeg' || format === 'jpg') {
        processedBuffer = await processor.jpeg({ quality }).toBuffer();
        res.setHeader('Content-Type', 'image/jpeg');
      } else {
        processedBuffer = await processor.png().toBuffer();
        res.setHeader('Content-Type', 'image/png');
      }

      res.setHeader('Content-Length', processedBuffer.length);
      res.send(processedBuffer);
    } catch (err) {
      res.status(500).json({ error: `Error capturing screenshot: ${err.message}` });
    } finally {
      await context?.close();
    }
  });

  app.post('/mhtml', async (req, res) => {
    let context;
    try {
      const { url, width, height, waitTime, asIs } = req.body;
      if (!url) return res.status(400).json({ error: 'missing url parameter' });
      const skipPreparation = asIs === true;

      const processedUrl = url.startsWith('http://') || url.startsWith('https://') ? url : `https://${url}`;
      context = await newContext();
      const page = await context.newPage();
      if (adblocker) await adblocker.enableBlockingInPage(page);

      if (width || height) {
        await page.setViewportSize({
          width: width ? parseInt(width, 10) : 1280,
          height: height ? parseInt(height, 10) : 720
        });
      }
      await navigateForScreenshot(page, processedUrl);

      if (!skipPreparation && !await waitForChallengeBypass(page)) {
        throw new Error('Challenge page did not clear; MHTML was not captured.');
      }
      await page.waitForTimeout(waitTime == null ? 1000 : parseInt(waitTime, 10));
      if (!skipPreparation) {
        await dismissModals(page);
        await loadLazyContent(page);
      }

      const data = Buffer.from(await captureMhtml(page), 'utf8');
      const hostname = new URL(processedUrl).hostname.replace(/[^a-zA-Z0-9.-]/g, '') || 'page';
      res.setHeader('Content-Type', 'multipart/related; type="text/html"');
      res.setHeader('Content-Disposition', `attachment; filename="page-${hostname}-${Date.now()}.mhtml"`);
      res.setHeader('Content-Length', data.length);
      res.send(data);
    } catch (err) {
      res.status(500).json({ error: `Error capturing MHTML: ${err.message}` });
    } finally {
      await context?.close();
    }
  });

  app.post('/shot-multi', async (req, res) => {
    let context;
    try {
      const { url, width, waitTime, outputs, output_format, output_quality } = req.body;

      if (!url) return res.status(400).json({ error: 'missing url parameter' });
      if (!outputs || !Array.isArray(outputs) || outputs.length === 0) {
        return res.status(400).json({ error: 'outputs must be a non-empty array' });
      }

      let processedUrl = url;
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        processedUrl = `https://${url}`;
      }

      context = await newContext();
      const page = await context.newPage();
      if (adblocker) await adblocker.enableBlockingInPage(page);

      await page.setViewportSize({ width: width ? parseInt(width, 10) : 1280, height: 720 });

      await navigateForScreenshot(page, processedUrl);
      await waitForChallengeBypass(page);

      await page.addStyleTag({
        content: `
          ::-webkit-scrollbar { display: none; }
          html { scrollbar-width: none; }
          html { -ms-overflow-style: none; }
        `
      });

      const additionalWait = waitTime == null ? 1000 : parseInt(waitTime, 10);
      await page.waitForTimeout(additionalWait);
      await dismissModals(page);

      const format = output_format || 'png';
      const quality = output_quality ? parseInt(output_quality, 10) : 80;

      // Catch late popups; loadLazyContent's waits give any close animation time to finish
      await page.keyboard.press('Escape');
      await loadLazyContent(page);
      const screenshotBuffer = await page.screenshot({ fullPage: true, type: 'png' });
      const status = await pageStatus(page);

      const problem = await screenshotProblem(page, screenshotBuffer);
      if (problem) return res.status(409).json({ error: problem, page_status: status });

      const metadata = await sharp(screenshotBuffer).metadata();

      const images = await Promise.all(outputs.map(async (output) => {
        const outputHeight = output.height ? parseInt(output.height, 10) : null;
        const outputWidth = output.output_width ? parseInt(output.output_width, 10) : null;
        const outputFormat = output.output_format || format;
        const outputQuality = output.output_quality ? parseInt(output.output_quality, 10) : quality;

        let processor = sharp(screenshotBuffer);

        if (outputHeight && metadata.height > outputHeight) {
          processor = processor.extract({ left: 0, top: 0, width: metadata.width, height: outputHeight });
        }

        if (outputWidth) {
          processor = processor.resize(outputWidth, null, { withoutEnlargement: true });
        }

        let buffer;
        let contentType;
        if (outputFormat === 'webp') {
          buffer = await processor.webp({ quality: outputQuality }).toBuffer();
          contentType = 'image/webp';
        } else if (outputFormat === 'jpeg' || outputFormat === 'jpg') {
          buffer = await processor.jpeg({ quality: outputQuality }).toBuffer();
          contentType = 'image/jpeg';
        } else {
          buffer = await processor.toBuffer();
          contentType = 'image/png';
        }

        const finalMetadata = await sharp(buffer).metadata();
        return {
          data: buffer.toString('base64'),
          content_type: contentType,
          height: finalMetadata.height,
          width: finalMetadata.width
        };
      }));

      res.json({ page_status: status, images });
    } catch (err) {
      res.status(500).json({ error: `Error capturing screenshots: ${err.message}` });
    } finally {
      await context?.close();
    }
  });

  async function shutdown() {
    browser.off('disconnected', onBrowserDisconnected);
    await browser.close();
    process.exit(0);
  }

  app.post('/shutdown', async (req, res) => {
    res.send('Shutting down');
    await shutdown();
  });

  app.listen(PORT, () => {
    console.log(`shot-server running on port ${PORT}`);
  });

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
})().catch(err => {
  console.error('shot-server error:', err);
  process.exit(1);
});
