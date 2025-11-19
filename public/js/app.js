let screenshotBlob = null;
let currentFilename = 'screenshot.png';

function toggleAdvanced() {
    document.getElementById('advanced-options').classList.toggle('visible');
}

function showError(message) {
    document.querySelector('.error')?.remove();
    const err = document.createElement('div');
    err.className = 'error';
    err.innerHTML = `<div class="error-title">Error</div><div>${message}</div>`;
    document.querySelector('.form-container').prepend(err);
}

async function captureScreenshot(e) {
    e.preventDefault();
    const btn = document.getElementById('submit-btn');
    const data = new FormData(e.target);
    const body = {url: data.get('url')};

    ['width', 'height', 'waitTime', 'output_width', 'output_quality'].forEach(f => {
        const v = data.get(f);
        if (v) body[f] = parseInt(v);
    });

    if (data.get('output_format')) body.output_format = data.get('output_format');

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>Capturing...';
    document.querySelector('.error')?.remove();

    try {
        const res = await fetch('/shot', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(body)
        });

        if (!res.ok) {
            const errorData = await res.json();
            throw new Error(errorData.error || 'Screenshot failed');
        }

        const contentType = res.headers.get('Content-Type');
        let extension = 'png';
        
        if (contentType === 'image/webp') {
            extension = 'webp';
        } else if (contentType === 'image/jpeg') {
            extension = 'jpg';
        }
        
        currentFilename = 'screenshot.' + extension;
        screenshotBlob = await res.blob();
        document.getElementById('screenshot-img').src = URL.createObjectURL(screenshotBlob);
        document.getElementById('result-container').classList.add('visible');
        document.getElementById('result-container').scrollIntoView({behavior: 'smooth'});
    } catch (error) {
        showError(error.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = '📸 Capture Screenshot';
    }
}

function downloadScreenshot() {
    if (!screenshotBlob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(screenshotBlob);
    a.download = currentFilename;
    a.click();
    URL.revokeObjectURL(a.href);
}

function resetForm() {
    document.getElementById('screenshot-form').reset();
    document.getElementById('result-container').classList.remove('visible');
    document.getElementById('url').focus();
    screenshotBlob = null;
}

document.getElementById('screenshot-form').addEventListener('submit', captureScreenshot);