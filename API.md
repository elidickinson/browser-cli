# Browser CLI Daemon API

## Screenshot Endpoint

The daemon exposes a `/api/screenshot` endpoint that allows you to capture screenshots of web pages directly via HTTP.

### Endpoint

`GET /api/screenshot`

### Query Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `url` | string | Yes | - | The URL to load and screenshot |
| `width` | integer | No | 1280 | Viewport width in pixels |
| `height` | integer | No | 720 | Viewport height in pixels |
| `fullPage` | boolean | No | false | Capture full scrollable page (true) or just viewport (false) |
| `waitTime` | integer | No | 1000 | Additional wait time in milliseconds after page load |

### Response

- **Content-Type**: `image/png`
- **Body**: PNG image binary data

### Examples

#### Basic screenshot
```bash
curl "http://localhost:3030/api/screenshot?url=https://example.com" -o screenshot.png
```

#### Full page screenshot
```bash
curl "http://localhost:3030/api/screenshot?url=https://example.com&fullPage=true" -o fullpage.png
```

#### Custom viewport size
```bash
curl "http://localhost:3030/api/screenshot?url=https://example.com&width=1920&height=1080" -o screenshot.png
```

#### With additional wait time
```bash
curl "http://localhost:3030/api/screenshot?url=https://example.com&waitTime=3000" -o screenshot.png
```

#### Combined parameters
```bash
curl "http://localhost:3030/api/screenshot?url=https://example.com&width=1920&height=1080&fullPage=true&waitTime=2000" -o screenshot.png
```

### Using with other HTTP clients

#### Python (requests)
```python
import requests

response = requests.get('http://localhost:3030/api/screenshot', params={
    'url': 'https://example.com',
    'width': 1920,
    'height': 1080,
    'fullPage': 'true'
})

with open('screenshot.png', 'wb') as f:
    f.write(response.content)
```

#### Node.js (axios)
```javascript
const axios = require('axios');
const fs = require('fs');

axios.get('http://localhost:3030/api/screenshot', {
    params: {
        url: 'https://example.com',
        width: 1920,
        height: 1080,
        fullPage: true
    },
    responseType: 'arraybuffer'
}).then(response => {
    fs.writeFileSync('screenshot.png', response.data);
});
```

#### Browser (JavaScript Fetch)
```javascript
fetch('http://localhost:3030/api/screenshot?url=https://example.com')
    .then(response => response.blob())
    .then(blob => {
        const url = URL.createObjectURL(blob);
        const img = document.createElement('img');
        img.src = url;
        document.body.appendChild(img);
    });
```

### Notes

- The endpoint navigates the active browser page to the specified URL
- Uses `networkidle` wait strategy to ensure page is loaded
- Screenshots are returned directly as binary data (not saved to disk)
- Ideal for integration with other services, APIs, or automation tools
- The browser context persists between requests, so cookies and sessions are maintained
