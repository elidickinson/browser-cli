#!/usr/bin/env node
const { program } = require('commander');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const PID_FILE = path.join(__dirname, '../daemon.pid');
const PORT = 3030;

function getRunningPid() {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8'), 10);
    process.kill(pid, 0);
    return pid;
  } catch (err) {
    return null;
  }
}

function send(path, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {};
    headers['Connection'] = 'close';

    const req = http.request({
      hostname: 'localhost',
      port: PORT,
      path,
      method,
      headers
    }, (res) => {
      let out = '';
      res.on('data', chunk => out += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(out);
        } else {
          try {
            const parsed = JSON.parse(out);
            resolve(parsed);
          } catch {
            resolve(out);
          }
        }
      });
    });
    req.on('error', (e) => {
      if (e.code === 'ECONNREFUSED') {
        reject('Daemon is not running. Please start it with "br start".');
      } else {
        console.log('Unknown error, try start the daemon with "br start":');
        console.error(e);
        reject(e);
      }
    });
    if (data) req.write(data);
    req.end();
  });
}

function asyncAction(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      console.error('Error:', err);
      process.exit(1);
    }
  };
}

// Check daemon status for help display
function getDaemonStatus() {
  const pid = getRunningPid();
  return pid ? `running (PID: ${pid})` : 'not running';
}

// Customize help to show daemon status
program.addHelpText('before', () => {
  return `\nDaemon status: ${getDaemonStatus()}\n`;
});

program
  .command('start')
  .description('Start the headless browser daemon process.')
  .option('--headless', 'Run the browser in headless mode (without a visible GUI)')
  .option('--viewport <size>', 'Set viewport size for headless mode (e.g., 1920x1080)', '1280x720')
  .option('--adblock', 'Enable ad blocking (blocks ads, trackers, and annoyances)')
  .option('--adblock-base <level>', 'Base filter level: none, adsandtrackers, full, or ads (default: adsandtrackers)')
  .option('--adblock-lists <paths>', 'Comma-separated list of additional filter list URLs or file paths')
  .option('--foreground', 'Run daemon in foreground (attached to terminal, not detached)')
  .option('--humanlike', 'Add random delays to simulate human-like interactions')
  .action(async (opts) => {
    const pid = getRunningPid();
    if (pid) {
      try {
        const health = await send('/health');
        if (health === 'ok') {
          console.log('Daemon is already running.');
          return;
        }
      } catch (err) {
        // Health check failed, assume daemon is stale
        console.log('Found stale daemon process, attempting to stop it...');
        try {
          process.kill(pid);
          fs.unlinkSync(PID_FILE);
          console.log('Stale daemon stopped.');
        } catch (killErr) {
          console.error('Failed to stop stale daemon, please check for zombie processes.');
          return;
        }
      }
    }

    // Prepare environment variables for daemon
    const env = { ...process.env };
    if (opts.headless) {
      env.BR_HEADLESS = 'true';
      console.log('Running in headless mode');

      // Parse viewport size (default: 1280x720)
      if (opts.viewport) {
        const [width, height] = opts.viewport.split('x').map(n => parseInt(n, 10));
        if (isNaN(width) || isNaN(height)) {
          console.error('Invalid viewport size format. Please use WIDTHxHEIGHT (e.g., 1920x1080)');
          process.exit(1);
        }
        env.BR_VIEWPORT_WIDTH = width.toString();
        env.BR_VIEWPORT_HEIGHT = height.toString();
        console.log(`Viewport size: ${width}x${height}`);
      }
    }
    if (opts.adblock) {
      env.BR_ADBLOCK = 'true';
      console.log('Ad blocking enabled');
    }
    if (opts.adblockBase) {
      env.BR_ADBLOCK_BASE = opts.adblockBase;
      console.log('Base filter level:', opts.adblockBase);
    }
    if (opts.adblockLists) {
      // Validate additional filter list files
      const adblockLists = opts.adblockLists.split(',');
      let invalidLists = [];

      for (const list of adblockLists) {
        const trimmedList = list.trim();
        // Skip URLs, only validate file paths
        if (!trimmedList.startsWith('http://') && !trimmedList.startsWith('https://')) {
          if (!fs.existsSync(trimmedList)) {
            invalidLists.push(trimmedList);
          }
        }
      }

      if (invalidLists.length > 0) {
        console.error(`Error: Filter list file(s) not found: ${invalidLists.join(', ')}`);
        process.exit(1);
      }

      env.BR_ADBLOCK_LISTS = opts.adblockLists;
      console.log('Additional filter lists:', opts.adblockLists);
    }
    if (opts.humanlike) {
      env.BR_HUMANLIKE = 'true';
      console.log('Human-like mode enabled');
    }

    if (opts.foreground) {
      // Run in foreground - don't detach, inherit stdio
      console.log('Starting daemon in foreground mode...');
      const child = spawn(process.execPath, [path.join(__dirname, '../daemon.js')], {
        detached: false,
        stdio: 'inherit',
        env
      });

      child.on('exit', code => {
        if (code !== 0) {
          console.error(`Daemon exited with code ${code}.`);
          process.exit(code);
        }
      });

    } else {
      // Run in background - detached mode
      const child = spawn(process.execPath, [path.join(__dirname, '../daemon.js')], {
        detached: true,
        stdio: 'ignore',
        env
      });

      child.unref();
      fs.writeFileSync(PID_FILE, String(child.pid));

      // Poll health endpoint to confirm daemon is ready
      const startTime = Date.now();
      const checkHealth = async () => {
        if (Date.now() - startTime > 5000) {
          console.error('Daemon failed to start in a timely manner.');
          process.exit(1);
        }

        try {
          await send('/health');
          console.log('Daemon started successfully.');
          process.exit(0);
        } catch (err) {
          setTimeout(checkHealth, 100);
        }
      };

      setTimeout(checkHealth, 100);
    }
  });

program
  .command('stop')
  .description('Stop the headless browser daemon process.')
  .action(() => {
    const pid = getRunningPid();
    if (!pid) {
      console.log('Daemon is not running.');
      return;
    }
    process.kill(pid);
    fs.unlinkSync(PID_FILE);
    console.log('Daemon stopped.');
  });

program
  .command('goto')
  .description('Navigate the browser to a specific URL.')
  .argument('<url>', 'The full URL to navigate to (e.g., "https://example.com").')
  .action(async (url) => {
    // Auto-add https:// if no protocol is specified
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }
    await send('/goto', 'POST', { url });
    console.log('Navigated to', url);
  });

program
  .command('scrollIntoView')
  .description('Scroll the page until a specific element is in view.')
  .argument('<selectorOrId>', 'CSS selector, XPath expression, or numeric ID from view-tree.')
  .action(asyncAction(async (selector) => {
    await send('/scroll-into-view', 'POST', { selector });
    console.log('Scrolled', selector, 'into view.');
  }));

program
  .command('scrollTo')
  .description('Scroll the page to a given percentage of its total height.')
  .argument('<percentage>', 'A number from 0 to 100.')
  .action(asyncAction(async (percentage) => {
    await send('/scroll-to', 'POST', { percentage });
    console.log(`Scrolled to ${percentage}%.`);
  }));

program
  .command('fill')
  .description('Fill a form field with the provided text.')
  .argument('<selectorOrId>', 'CSS selector, XPath expression, or numeric ID from view-tree.')
  .argument('<text>', 'The text to fill the field with.')
  .action(asyncAction(async (selector, text) => {
    await send('/fill', 'POST', { selector, text });
    console.log('Filled', selector);
  }));

program
  .command('fill-secret')
  .description('Fill a form field with a value from a specified environment variable. The value is masked in logs.')
  .argument('<selectorOrId>', 'CSS selector, XPath expression, or numeric ID from view-tree.')
  .argument('<envVar>', 'The name of the environment variable containing the secret.')
  .action(asyncAction(async (selector, envVar) => {
    const secret = process.env[envVar];
    if (!secret) {
      console.error(`Error: Environment variable "${envVar}" is not set.`);
      process.exit(1);
    }
    await send('/fill-secret', 'POST', { selector, secret });
    console.log('Filled secret value into', selector);
  }));

program
  .command('type')
  .description('Simulate typing text into a form field, character by character.')
  .argument('<selectorOrId>', 'CSS selector, XPath expression, or numeric ID from view-tree.')
  .argument('<text>', 'The text to type into the field.')
  .action(asyncAction(async (selector, text) => {
    await send('/type', 'POST', { selector, text });
    console.log('Typed text into', selector);
  }));

program
  .command('press')
  .description("Simulate a single key press (e.g., 'Enter', 'Tab').")
  .argument('<key>', "The key to press, as defined in Playwright's documentation.")
  .action(asyncAction(async (key) => {
    await send('/press', 'POST', { key });
    console.log('Pressed', key);
  }));

program
  .command('fill-search')
  .description('Fill a search input and submit the query.')
  .argument('<query>', 'The search query to enter.')
  .option('-s, --selector <selector>', 'Explicit CSS selector, XPath expression, or numeric ID from view-tree for the search input')
  .action(asyncAction(async (query, opts) => {
    const body = { query };
    if (opts.selector) body.selector = opts.selector;
    const response = await send('/fill-search', 'POST', body);
    console.log('Searched for:', query);
    if (response.selector) {
      console.log('Used selector:', response.selector);
    }
  }));

program
  .command('nextChunk')
  .description('Scroll down by one viewport height to view the next chunk of content.')
  .action(asyncAction(async () => {
    await send('/next-chunk', 'POST');
    console.log('Scrolled to the next chunk.');
  }));

program
  .command('prevChunk')
  .description('Scroll up by one viewport height to view the previous chunk of content.')
  .action(asyncAction(async () => {
    await send('/prev-chunk', 'POST');
    console.log('Scrolled to the previous chunk.');
  }));

program
  .command('click')
  .description('Click an element. Supports CSS selectors, XPath, and view-tree IDs.')
  .argument('<selectorOrId>', 'CSS selector (e.g., "input"), XPath expression, or numeric ID from view-tree.')
  .action(asyncAction(async (selector) => {
    await send('/click', 'POST', { selector });
    console.log('Clicked', selector);
  }));

program
  .command('screenshot')
  .description('Capture a screenshot of the current page and save it to a file.')
  .option('-f, --full-page', 'Capture the full scrollable page instead of just the viewport')
  .option('-o, --output <path>', 'Custom file path for the screenshot')
  .action(async (opts) => {
    const fullPage = opts.fullPage || false;
    const params = new URLSearchParams({ fullPage });
    if (opts.output) params.append('path', opts.output);
    const file = await send(`/screenshot?${params}`);
    console.log('Screenshot saved to:', file);
  });

program
  .command('view-html')
  .description('Output the full HTML source of the current page (paginated, 5000 chars per page).')
  .option('-p, --page <number>', 'Page number to view', '1')
  .action(async (opts) => {
    const page = Number(opts.page) || 1;
    const html = await send(`/html?page=${page}`);
    if (html.length === 0) {
      console.log('No HTML content found for this page.');
      return;
    }
    const PAGE_SIZE = 5000;
    const totalPages = Math.ceil(html.length / PAGE_SIZE);
    const start = (page - 1) * PAGE_SIZE;
    const end = start + PAGE_SIZE;
    const chunk = html.slice(start, end);
    console.log(chunk);
    console.log(`\n--- Page ${page} of ${totalPages} ---`);
    if (totalPages > 1) {
      console.log('Use --page <n> to view a different page.');
    }
    if (html.length > PAGE_SIZE) {
      console.log('Hint: If the HTML is too large to view comfortably, try the "view-tree" command for a structured overview.');
    }
  });

program
  .command('history')
  .alias('hist')
  .description('Display the history of actions performed in the current session.')
  .action(async () => {
    const hist = await send('/history');
    console.log(hist);
  });

program
  .command('clear-history')
  .description("Clear the session's action history.")
  .action(async () => {
    await send('/history/clear', 'POST');
    console.log('History cleared.');
  });

program
  .command('view-tree')
  .description("Display a hierarchical tree of the page's accessibility and DOM nodes.")
  .action(async () => {
    const response = await send('/tree');
    let tree = response.tree;

    // Handle the case where tree is still a string (daemon not restarted yet)
    if (typeof tree === 'string') {
      console.log(tree);
      return;
    }

    function displayNode(node, indent = 0) {
      const parts = [`${'  '.repeat(indent)}[${node.id}]`];
      if (node.role) parts.push(node.role);
      if (node.tag) parts.push(node.tag);
      if (node.name) parts.push(`: ${node.name}`);
      console.log(parts.join(' '));

      if (node.children && node.children.length > 0) {
        node.children.forEach(child => displayNode(child, indent + 1));
      }
    }

    if (tree) {
      displayNode(tree);
    } else {
      console.log('No tree data found');
    }
  });

program
  .command('tabs')
  .description('List all open tabs (pages) in the browser daemon.')
  .action(async () => {
    const tabs = await send('/tabs');
    tabs.forEach(tab => {
      console.log(`${tab.isActive ? '*' : ' '}${tab.index}: ${tab.title} (${tab.url})`);
    });
  });

program
  .command('switch-tab')
  .description('Switch to a different open tab by its index.')
  .argument('<index>', 'The index of the tab to switch to.')
  .action(async (index) => {
    await send('/tabs/switch', 'POST', { index: Number(index) });
    console.log('Switched to tab', index);
  });

program
  .command('eval')
  .description('Execute JavaScript in the browser context and return the result.')
  .argument('[script]', 'JavaScript code to execute (if not using --file).')
  .option('-f, --file <path>', 'Path to a JavaScript file to execute.')
  .action(asyncAction(async (script, opts) => {
    let scriptToRun = script;

    if (opts.file) {
      // Read JavaScript from file
      if (!fs.existsSync(opts.file)) {
        console.error(`Error: File not found: ${opts.file}`);
        process.exit(1);
      }
      scriptToRun = fs.readFileSync(opts.file, 'utf8');
    }

    if (!scriptToRun) {
      console.error('Error: No script provided. Use either a script argument or --file option.');
      process.exit(1);
    }

    const response = await send('/eval', 'POST', { script: scriptToRun });
    const { result } = response;

    // Pretty print the result
    if (result === undefined) {
      console.log('undefined');
    } else if (result === null) {
      console.log('null');
    } else if (typeof result === 'object') {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(result);
    }
  }));

program
  .command('extract-text')
  .description('Extract visible text from the page or specific elements.')
  .option('-s, --selector <selector>', 'CSS selector, XPath expression, or numeric ID from view-tree to extract text from specific elements')
  .action(asyncAction(async (opts) => {
    const body = {};
    if (opts.selector) body.selector = opts.selector;
    const response = await send('/extract-text', 'POST', body);
    console.log(response.text);
    if (response.selector) {
      console.log('(using selector:', response.selector + ')');
    }
  }));

// Show help for unknown commands
program.on('command:*', (operands) => {
  console.error(`error: unknown command '${operands[0]}'`);
  console.log();
  program.outputHelp();
  process.exit(1);
});

try {
  program.parse();
} catch (err) {
  if (err.code === 'commander.unknownOption') {
    console.log();
    program.outputHelp();
  }
}
