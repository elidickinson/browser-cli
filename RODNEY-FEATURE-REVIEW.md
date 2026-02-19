# Feature Review: simonw/rodney

Comparison of [rodney](https://github.com/simonw/rodney) (Go/rod, 375 stars) against
browser-cli (Node/Playwright). This document identifies features worth borrowing,
ranked by impact.

---

## High Priority — Strong candidates to adopt

### 1. Wait primitives (`wait`, `waitload`, `waitstable`, `waitidle`)

Rodney exposes four distinct wait commands:

| Command | Waits for |
|---------|-----------|
| `wait <selector>` | Element exists **and** is visible |
| `waitload` | Page `load` event |
| `waitstable` | DOM stops changing (no layout shifts) |
| `waitidle` | Network goes idle |

**Why it matters:** browser-cli currently has no explicit wait commands. LLM agents
and scripts often need to pause until a page is ready before extracting content or
interacting. Without these, agents resort to fragile `sleep`-based polling.

**Suggested commands:** `br wait <selector>`, `br wait-load`, `br wait-stable`,
`br wait-idle`. Playwright already exposes `page.waitForLoadState('networkidle')`,
`page.waitForSelector()`, etc., so implementation is straightforward.

---

### 2. Structured exit codes

Rodney uses a three-tier exit code scheme:

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Check/assertion failed (element not found, condition false) |
| 2 | Error (bad args, timeout, browser crash) |

**Why it matters:** browser-cli currently doesn't distinguish between "the check
returned false" and "something broke." For scripting and CI/CD pipelines, this
distinction is essential. LLM agents can also use exit codes to decide whether to
retry vs. take a different path.

**Suggested change:** Adopt the 0/1/2 convention across all commands. Audit
existing error paths in `daemon.js` and `bin/br.js`.

---

### 3. Navigation commands (`back`, `forward`, `reload --hard`, `clear-cache`)

Rodney has `back`, `forward`, `reload` (with `--hard` flag for cache-bypassing
reload), and `clear-cache`.

**Why it matters:** browser-cli has `goto` but no way to go back/forward in
history, hard-reload, or clear cache. These are basic browser operations that agents
and scripts need regularly.

**Suggested commands:** `br back`, `br forward`, `br reload [--hard]`,
`br clear-cache`.

---

### 4. DOM query commands (`exists`, `visible`, `count`, `attr`)

| Command | Returns |
|---------|---------|
| `exists <sel>` | `true`/`false` (exit 1 if false) |
| `visible <sel>` | `true`/`false` (exit 1 if false) |
| `count <sel>` | Integer count of matching elements |
| `attr <sel> <name>` | Attribute value |

**Why it matters:** LLM agents frequently need to check whether an element exists
before clicking it, count search results, or read an attribute (e.g., `href`,
`data-*`). Currently browser-cli requires `br eval` with custom JS for all of
these, which is verbose and error-prone for agents.

**Suggested commands:** `br exists <sel>`, `br visible <sel>`, `br count <sel>`,
`br attr <sel> <name>`.

---

### 5. `select` (dropdowns) and `submit` (forms)

Rodney has `select <selector> <value>` (sets value + dispatches change event) and
`submit <selector>` (calls `.submit()` on a form element).

**Why it matters:** browser-cli has `fill` and `click` but no dedicated dropdown
or form submission commands. Agents automating forms with `<select>` elements
currently have no clean path. The `submit` command is useful when there's no
visible submit button (common in single-field forms).

**Suggested commands:** `br select <selector> <value>`,
`br submit <selector>`.

---

### 6. PDF export

Rodney has `pdf [filename]` using Chrome's built-in `Page.printToPDF` CDP call.

**Why it matters:** Useful for archiving pages, generating reports, and capturing
full-page content in a portable format. Playwright supports this natively via
`page.pdf()`.

**Suggested command:** `br pdf [-o filename] [--full-page]`.

---

## Medium Priority — Worth considering

### 7. `assert` command

Rodney provides `assert <js-expression> [expected]` with optional `--message`.
Two modes: truthy check (one arg) or equality check (two args). Exits 1 on
failure with a formatted message.

**Why it matters:** Useful for CI/CD smoke tests and automated validation.
Combined with structured exit codes, this turns browser-cli into a lightweight
E2E testing tool.

**Suggested command:** `br assert <js-expr> [expected] [--message msg]`.

---

### 8. File upload (`file <selector> <path>`)

Rodney supports `file <selector> <path>` with stdin support (`-` reads from
stdin to a temp file). Uses CDP's `setFiles` API.

**Why it matters:** browser-cli has no file upload support. Agents automating
workflows that involve file uploads (document submission, image uploads) are
currently blocked.

**Suggested command:** `br upload <selector> <path>`.

---

### 9. Element-level screenshots (`screenshot-el <selector>`)

Rodney can screenshot a specific element rather than the full viewport.

**Why it matters:** Useful for capturing specific UI components, error messages,
or results without the surrounding page chrome. browser-cli's `screenshot`
currently captures the full viewport or full page.

**Suggested flag:** `br screenshot --element <selector>`.

---

### 10. Download command

Rodney's `download <selector> [file|-]` extracts the `href`/`src` from an
element and downloads it using the page's fetch context (preserving cookies).
Handles data URLs, auto-infers filenames, and supports stdout output.

**Why it matters:** Downloading files through the browser session preserves
authentication state. Agents scraping authenticated content (PDFs, CSVs, images)
currently have no way to download linked resources.

**Suggested command:** `br download <selector> [-o file]`.

---

### 11. Local/project-scoped sessions

Rodney supports `--local` to store session state in `./.rodney/` instead of the
global `~/.rodney/`. Auto-detection checks the current directory first.

**Why it matters:** Enables per-project browser sessions that don't interfere
with each other. Useful in CI/CD and when working on multiple projects
simultaneously.

**Suggested enhancement:** Support `--local` flag on `br start` to use
`./.br/` in the current directory. Auto-detect local sessions.

---

## Lower Priority — Nice to have

### 12. `hover`, `focus`, `clear` interaction primitives

Simple element interaction commands that Rodney exposes.

**Assessment:** `hover` could be useful for triggering tooltips or dropdown
menus. `focus` and `clear` are less critical since `fill` already handles most
input scenarios.

---

### 13. `newpage` / `closepage` tab lifecycle

Rodney has `newpage` and `closepage` alongside the tab listing/switching that
browser-cli already has.

**Assessment:** browser-cli already has `tabs` and `switch-tab`. Adding
`new-tab` and `close-tab` would round out the tab management story.

---

### 14. Configurable timeout via environment variable

Rodney uses `ROD_TIMEOUT` to override the default 30s command timeout.

**Assessment:** browser-cli should consider a `BR_TIMEOUT` env var for
long-running operations.

---

## Features browser-cli already does better

| Feature | browser-cli | rodney |
|---------|-------------|--------|
| **Ad blocking** | Built-in with Ghostery, multiple filter levels, custom lists | None |
| **Named instances** | Multiple concurrent named daemons | One global + one local only |
| **Console capture** | Dedicated `br console` with filtering by type/tab | PR #34 (not merged) |
| **Human-like mode** | `--humanlike` randomized delays | None |
| **Secret handling** | `fill-secret` reads env vars, masks in logs | None |
| **Smart search** | `fill-search` auto-detects search inputs | None |
| **View tree** | Combined accessibility + DOM tree with ID mapping | Separate ax-tree only |
| **Screenshot server** | Dedicated HTTP endpoint for programmatic screenshots | CLI only |
| **Character-by-character typing** | `br type` with configurable delays | None |
| **Challenge detection** | Auto-detects Cloudflare/SiteGround challenges | None |

---

## Recommended implementation order

1. **Wait primitives** — highest agent impact, easy to implement
2. **Navigation (back/forward/reload/clear-cache)** — basic gaps, trivial to add
3. **DOM queries (exists/visible/count/attr)** — high agent utility
4. **Structured exit codes** — important for scripting, requires audit
5. **select + submit** — fills form automation gaps
6. **PDF export** — one Playwright call
7. **File upload** — unblocks upload workflows
8. **assert** — CI/CD testing value
9. **Element screenshots** — incremental enhancement
10. **Download** — authenticated file retrieval
11. **Local sessions** — project isolation
