# Browser CLI Daemon API

The Browser CLI Daemon exposes several endpoints for browser automation, navigation, content extraction, and interaction.

## Browser Control Endpoints

### Navigate to a URL
```
POST /goto
Content-Type: application/json

{
  "url": "https://example.com"
}
```

### Click an element
```
POST /click
Content-Type: application/json

{
  "selector": "#button-id",
  "position": "center" // Optional: "center", "top", "bottom", "left", "right"
}
```

### Type text
```
POST /type
Content-Type: application/json

{
  "selector": "#input-field",
  "text": "Hello World"
}
```

### Extract page content
```
GET /content
```

Returns the HTML content of the current page.

## Content Extraction Endpoints

### Extract page as JSON
```
GET /dom
```

Returns a structured JSON representation of the DOM with XPath mappings.

### Extract accessibility tree
```
GET /ax
```

Returns the accessibility tree of the current page.

### Extract main content
```
POST /extract-content
Content-Type: application/json

{
  "selector": "article.content" // Optional: CSS selector to scope extraction
}
```

Returns the main content of the page in LLM-friendly format:

```json
{
  "title": "Page Title",
  "url": "https://example.com/page",
  "description": "Meta description of the page",
  "byline": "Author name (if available)",
  "excerpt": "Brief excerpt of the article",
  "content": "# Markdown content\n\nThe main article content...",
  "wordCount": 1234,
  "selector": "article.content" // Only included if selector was specified
}
```

Uses Mozilla Readability to extract the main article/content (stripping navigation, ads, sidebars, etc.) and converts it to clean Markdown using Turndown. Also extracts page metadata (title, meta description, Open Graph tags).

## Session Management

### Get browser info
```
GET /info
```

Returns browser version, page count, and other session information.

### Export current page as MHTML
```
GET /mhtml?path=/tmp/page.mhtml&asIs=true
```

`path` and `asIs` are optional. By default, capture waits for challenge bypass (and fails if it does not clear), dismisses modals, and triggers lazy-loaded content. Set `asIs=true` to capture the current page without preparation. Returns the saved file path. In desktop sessions without an emulated viewport, preparation updates lazy-loading attributes but does not expand the viewport to trigger below-the-fold JavaScript loaders.

### Close session
```
POST /shutdown
```

Gracefully shuts down the browser daemon.

### Notes

- The daemon maintains a persistent browser context that persists between requests
- Cookies and sessions are maintained across requests
- Most endpoints operate on the currently active browser tab
- The daemon supports tab management through dedicated endpoints

## Screenshot Endpoints

Do not expose this server to untrusted clients. It can fetch internal-network URLs, and MHTML exports include page content and embedded resources.

Requests that run longer than 120 seconds fail with a 500. If Chrome stops responding entirely, the server exits so its service manager can restart it.

### Capture single screenshot
```
POST /shot
Content-Type: application/json

{
  "url": "https://example.com",
  "width": 1920,
  "height": 1080,
  "waitTime": 1000,
  "output_format": "png",
  "output_quality": 80
}
```

Returns the screenshot as an image buffer with appropriate Content-Type header. The `X-Page-Status` and `X-Final-URL` response headers carry the HTTP status and URL of the document shown in the screenshot (after redirects and challenge reloads), and are set on 409 responses too. A non-2xx page status is still returned as 200 with the image.

### Export a page as MHTML
```
POST /mhtml
Content-Type: application/json

{
  "url": "https://example.com",
  "width": 1920,
  "height": 1080,
  "waitTime": 1000,
  "asIs": false
}
```

Returns the MHTML archive bytes with `Content-Type: multipart/related` and an attachment filename. `width`, `height`, `waitTime`, and `asIs` are optional. By default, capture waits for challenge bypass (and fails if it does not clear), dismisses modals, and triggers lazy-loaded content. Set `asIs: true` to skip that preparation while still navigating to the URL. The `X-Page-Status` and `X-Final-URL` response headers carry the HTTP status and URL of the captured document (after redirects and challenge reloads).

### Export a page as HTML
```
POST /html
```

Takes the same body, preparation, and response headers as `POST /mhtml`. Returns the rendered DOM serialized as HTML (`Content-Type: text/html; charset=utf-8`) with an attachment filename. Resources are not embedded.

### Capture multiple screenshots
```
POST /shot-multi
Content-Type: application/json

{
  "url": "https://example.com",
  "width": 1920,
  "waitTime": 1000,
  "output_format": "webp",
  "output_quality": 80,
  "outputs": [
    { "height": 720, "output_width": 640 },
    { "height": 1080, "output_width": 1280 }
  ]
}
```

Returns:
```json
{
  "page_status": 200,
  "final_url": "https://example.com/",
  "images": [
    {
      "data": "base64-encoded-image...",
      "content_type": "image/webp",
      "height": 720,
      "width": 640
    }
  ]
}
```

The `/shot-multi` endpoint loads the page once and generates multiple screenshots with different dimensions. `page_status` and `final_url` are the HTTP status and URL of the document shown in the screenshots (after redirects and challenge reloads), and are included on 409 responses too. Each output specification can include:
- `height` - Crop to this height from the top of the page
- `output_width` - Resize to this width (maintains aspect ratio)
- `output_format` - Override format per output (png, jpg, webp)
- `output_quality` - Override quality per output (for webp/jpg)