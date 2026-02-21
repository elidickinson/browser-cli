# @browsemake/shot-server

Standalone screenshot server. Launches a headless browser and exposes an HTTP API for capturing screenshots with image processing (resize, format conversion, quality control).

## Usage

```bash
npx @browsemake/shot-server
```

The server starts on port 3031 by default and includes a web UI at `http://localhost:3031`.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `SHOT_PORT` | `3031` | Port to listen on |
| `BR_ADBLOCK` | | Set to `true` to enable ad blocking |
| `BR_ADBLOCK_BASE` | `adsandtrackers` | Filter level: `none`, `ads`, `adsandtrackers`, `full` |
| `BR_ADBLOCK_LISTS` | | Comma-separated URLs or file paths for custom filter lists |

## API

### `POST /shot` - Single screenshot

```bash
curl -X POST http://localhost:3031/shot \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","width":1920,"height":1080}' \
  -o screenshot.png
```

Request body:

| Field | Required | Description |
|---|---|---|
| `url` | yes | URL to screenshot |
| `width` | no | Viewport width (default: 1280) |
| `height` | no | Viewport height (default: 720). Omit for full-page screenshot |
| `waitTime` | no | Extra wait in ms after page load (default: 1000) |
| `output_width` | no | Resize output to this width |
| `output_format` | no | `png`, `webp`, or `jpeg` (default: png) |
| `output_quality` | no | Quality 1-100 for webp/jpeg (default: 80) |

Returns the image directly with appropriate `Content-Type`.

### `POST /shot-multi` - Multiple screenshots from one page load

```bash
curl -X POST http://localhost:3031/shot-multi \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com",
    "width": 1920,
    "outputs": [
      {"height": 720, "output_width": 640},
      {"height": 1080, "output_width": 1280}
    ]
  }'
```

Returns JSON:
```json
{
  "images": [
    {
      "data": "base64...",
      "content_type": "image/png",
      "width": 640,
      "height": 720
    }
  ]
}
```

### `GET /health`

Returns `ok`.

### `POST /shutdown`

Gracefully shuts down the server.
