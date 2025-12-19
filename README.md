<p align="center">
  <img width="full" src="https://github.com/user-attachments/assets/ac1cd9e3-f811-4af7-9338-7d6d0c80fcd7" />
</p>


<h1 align="center">Browser CLI </h1>

**Fork of [browsemake/browser-cli](https://github.com/browsemake/browser-cli) with additional features:**
- JavaScript execution (`br eval`) for running custom scripts on web pages
- Enhanced screenshot options with custom paths and full-page capture
- Ad blocking with configurable filter levels and custom blocklists

<hr><br>

<div align="center">
  
  [![Discord](https://img.shields.io/discord/1391101800052035714?color=7289DA&label=Discord&logo=discord&logoColor=white)](https://discord.gg/N7crMvEX)
  [![Twitter Follow](https://img.shields.io/twitter/follow/browse_make?style=social)](https://x.com/intent/user?screen_name=browse_make)
  
</div>

`br` is a command line tool used by any capable LLM agent, like ChatGPT, [Claude Code](https://github.com/anthropics/claude-code) or [Gemini CLI](https://github.com/google-gemini/gemini-cli).

https://www.npmjs.com/package/@browsemake/browser-cli

## Why Broswer CLI?
- **Just works**: simply browser automation, coding not required, leave the rest workflow to the most powerful LLM agent
- **AI first**: designed for LLM agent, readable view from HTML, and error hint
- **Secure**: can be run locally, no credential passed to LLM 
- **Robust**: browser persisted progress across session, and track history action for replay
<br />

## Install
```bash
npm install -g @browsemake/browser-cli
```

## Usage
Type instruction to AI agent (Gemini CLI / Claude Code / ChatGPT):

```
> You have browser automation tool 'br', use it to go to amazon to buy me a basketball
```

Use command line directly by human:

```bash
br start
br goto https://github.com/
```

For headless mode (without a visible browser window):

```bash
br start --headless
br goto https://github.com/
```

For headless mode with custom viewport size:

```bash
br start --headless --viewport 1920x1080
br goto https://github.com/
```

## Demos

Grocery (Go to Amazon and buy me a basketball)
<div align="center">
    <a href="https://www.loom.com/share/b7aeba65bb0b4c4bb5bbef9b59b4b9dc">
      <img style="max-width:300px;" src="https://github.com/user-attachments/assets/3cd46b9a-6ef9-4987-a952-fcd22890334c">
    </a>
</div>

Navigate to GitHub repo:
<div align="center">
    <a href="https://www.loom.com/share/0ef198e259864ae08afa9ae9f78acfac">
      <img style="max-width:300px;" src="https://cdn.loom.com/sessions/thumbnails/0ef198e259864ae08afa9ae9f78acfac-3e42df07f2040874-full-play.gif">
    </a>
</div>


Print invoice

Download bank account statement

Search for job posting

## Features
- **Browser Action**: Comprehensive action for browser automation (navigation, click, etc.)
- **LLM friendly output**: LLM friendly command output with error correction hint
- **Daemon mode**: Always-on daemon mode so it lives across multiple LLM sessions
- **Structured web page view**: Accessibility tree view for easier LLM interpretation than HTML
- **Secret management**: Secret management to isolate password from LLM
- **History tracking**: History tracking for replay and scripting
- **Ad blocking**: Optional ad and tracker blocking with custom filter list support
- **JavaScript injection**: Execute custom JavaScript code on web pages
- **HTTP API**: REST API endpoint for taking screenshots programmatically

## Command

### Start the daemon
```bash
br start
```

For headless mode (without a visible browser window):
```bash
br start --headless
```

For headless mode with custom viewport size:
```bash
br start --headless --viewport 1920x1080
```

If starting the daemon fails (for example due to missing Playwright browsers),
the CLI prints the error output so you can diagnose the issue.

### Navigate to a URL
```bash
br goto https://example.com
```

### Click an element

```bash
br click "button.submit"
```

Commands that accept a CSS selector (like `click`, `fill`, `scrollIntoView`, `type`) can also accept a numeric ID. These IDs are displayed in the output of `br view-tree` and allow for direct interaction with elements identified in the tree.

### Scroll element into view

```bash
br scrollIntoView "#footer"
```

### Scroll to percentage of page

```bash
br scrollTo 50
```

### Fill an input field

```bash
br fill "input[name='q']" "search text"
```

### Fill an input field with a secret

```bash
MY_SECRET="top-secret" br fill-secret "input[name='password']" MY_SECRET
```

When retrieving page HTML with `br view-html`, any text provided via
`fill-secret` is masked to avoid exposing secrets.

### Type text into an input

```bash
br type "input[name='q']" "search text"
```

### Press a key

```bash
br press Enter
```

### Scroll next/previous chunk

```bash
br nextChunk
br prevChunk
```

### View page HTML

```bash
br view-html
```

### View action history

```bash
br history
```

### Clear action history

```bash
br clear-history
```

### Capture a screenshot

```bash
# Capture just the viewport (default)
br screenshot

# Capture the full scrollable page
br screenshot --full-page

# Save to custom file path
br screenshot -o my-screenshot.png
br screenshot --output /tmp/screen.png
```

Screenshots are saved with the format `shot-{domain}-{timestamp}.png` by default, or to a custom path if specified with `-o/--output`.

### View accessibility and DOM tree

```bash
br view-tree
```

Outputs a hierarchical tree combining accessibility roles with DOM element
information. It also builds an ID-to-XPath map for quick element lookup.

### List open tabs

```bash
br tabs
```

### Switch to a tab by index

```bash
br switch-tab 1
```

### Start daemon with options

```bash
# Run in headless mode (without a visible GUI)
br start --headless

# Run in headless mode with custom viewport size (default: 1280x720)
br start --headless --viewport 1920x1080

# Enable ad blocking (ads + tracking)
br start --adblock

# Full protection (ads + tracking + annoyances + cookies)
br start --adblock --adblock-base full

# Combine headless mode with ad blocking
br start --headless --adblock

# Combine all options
br start --headless --viewport 1920x1080 --adblock --adblock-base full

# Use custom filter lists only (can be URLs or local files)
br start --adblock none --adblock-lists https://example.com/list1.txt,/path/to/local-list.txt
```

**Options:**
- `--headless` - Run the browser in headless mode (without a visible GUI)
- `--viewport <size>` - Set viewport size for headless mode (format: WIDTHxHEIGHT, e.g., 1920x1080) [default: 1280x720]
- `--adblock` - Enable ad blocking
- `--adblock-base <level>` - Base filter level: `none`, `adsandtrackers`, `full` (ads + trackers + annoyances + cookies), or `ads` [default: `adsandtrackers`]
- `--adblock-lists <paths>` - Comma-separated additional filter list URLs or local file paths

Ad blocking is powered by [@ghostery/adblocker-playwright](https://github.com/ghostery/adblocker) with blocklists from EasyList, EasyPrivacy, and uBlock Origin.

### Execute JavaScript

```bash
# Execute JavaScript code
br js "document.body.style.backgroundColor = 'lightblue'"

# Execute JavaScript and return the result
br js "return document.title"

# Execute multi-line JavaScript
br js "
const elements = document.querySelectorAll('button');
elements.forEach(el => el.style.border = '2px solid red');
return elements.length;
"
```

The `js` command executes JavaScript code in the context of the current page and returns any value that is explicitly returned from the script.

### HTTP API for Screenshots

The daemon exposes an HTTP endpoint for programmatic screenshot capture:

```bash
# Basic usage
curl -X POST "http://localhost:3030/goto" -H "Content-Type: application/json" -d '{"url":"https://example.com"}'

# Take a screenshot
curl -X POST "http://localhost:3030/shot" -H "Content-Type: application/json" -d '{"url":"https://example.com","width":1920,"height":1080}' -o screenshot.png
```

See [API.md](API.md) for complete API documentation and examples in multiple languages.

### Stop the daemon

```bash
br stop
```

The daemon runs a headless Chromium browser and exposes a small HTTP API. The CLI communicates with it to perform actions like navigation and clicking elements.

## Future Features

Based on insights from the "Building Browser Agents" research paper and real-world agent usage, here are potential improvements being considered:

### Enhanced Context Management
- **Visual snapshots for ambiguous elements** (Low complexity) - Add small screenshots for visually similar buttons or icon-only elements when text alone isn't sufficient
- **Element state indicators** (Low complexity) - Include `visible`, `enabled`, `focused`, `checked` states in view-tree output
- **Bounding box data** (Low complexity) - Add coordinates to help agents understand spatial layout

### Action Verification & Feedback
- **Action result summaries** (Medium complexity) - Return what changed after actions (e.g., "Clicked button → modal appeared")
- **Before/after tree diffs** (Medium complexity) - Show minimal DOM changes after actions so agents can verify success
- **Wait-for-stable** (Medium complexity) - Auto-wait for DOM to stabilize after clicks/navigations

### Reliability Improvements
- **Retry with fallback selectors** (Low complexity) - If click by ID fails, auto-retry with text match
- **Element visibility verification** (Low complexity) - Prevent clicks on hidden/off-screen elements
- **Challenge detection reporting** (Low complexity) - Warn agents when Cloudflare or other challenges appear

### Context Optimization
- **Filtered/interactive-only view** (Low complexity) - Show only buttons, links, inputs to reduce context
- **Viewport-only tree** (Low complexity) - Elements currently visible on screen
- **Depth limiting** (Low complexity) - `view-tree --depth 3` to control output size

### High-Level Convenience Commands
- **Search helper** (Low complexity) - `br search <query>` for fill search box + submit
- **Login helper** (Medium complexity) - `br login <user-env> <pass-env>` to find form + fill + submit
- **Wait-for element** (Low complexity) - `br wait-for <selector>` for explicit waits
- **Extract text** (Low complexity) - `br extract-text <selector>` for content retrieval

These features aim to reduce the number of decisions agents must make for common tasks while maintaining the tool's simplicity and reliability. Priority will be given to features that most frequently cause agent failures in real-world usage.
