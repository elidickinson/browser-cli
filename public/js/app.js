let screenshotBlob = null;
let currentFilename = 'screenshot.png';
let currentMode = 'single';
let outputConfigs = [];
let multiImages = [];

function toggleAdvanced() {
    document.getElementById('advanced-options').classList.toggle('visible');
}

function setMode(mode) {
    currentMode = mode;
    document.querySelectorAll('.mode-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === mode);
    });

    const multiSection = document.getElementById('multi-section');
    const advancedOptions = document.getElementById('advanced-options');
    const submitBtn = document.getElementById('submit-btn');

    if (mode === 'multi') {
        multiSection.classList.remove('hidden');
        advancedOptions.classList.add('visible');
        if (outputConfigs.length === 0) {
            addOutput();
            addOutput();
        }
        submitBtn.textContent = '📸 Capture Multiple Screenshots';
    } else {
        multiSection.classList.add('hidden');
        submitBtn.textContent = '📸 Capture Screenshot';
    }
    resetForm();
}

function addOutput() {
    const id = Date.now();
    outputConfigs.push({ id, height: null, output_width: null });
    renderOutputs();
}

function removeOutput(id) {
    outputConfigs = outputConfigs.filter(c => c.id !== id);
    renderOutputs();
}

function updateOutput(id, field, value) {
    const config = outputConfigs.find(c => c.id === id);
    if (config) config[field] = value || null;
}

function renderOutputs() {
    const list = document.getElementById('outputs-list');
    list.innerHTML = outputConfigs.map((c, i) => `
        <div class="output-row">
            <span class="output-label">Output ${i + 1}</span>
            <input type="number" placeholder="Height (px)" class="output-input"
                onchange="updateOutput(${c.id}, 'height', this.value)"
                value="${c.height || ''}">
            <input type="number" placeholder="Output Width (px)" class="output-input"
                onchange="updateOutput(${c.id}, 'output_width', this.value)"
                value="${c.output_width || ''}">
            <button type="button" class="btn-remove" onclick="removeOutput(${c.id})">×</button>
        </div>
    `).join('');
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

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>Capturing...';
    document.querySelector('.error')?.remove();

    try {
        if (currentMode === 'multi') {
            await captureMultiScreenshot(data);
        } else {
            await captureSingleScreenshot(data);
        }
    } catch (error) {
        showError(error.message);
    } finally {
        btn.disabled = false;
        btn.textContent = currentMode === 'multi' ? '📸 Capture Multiple Screenshots' : '📸 Capture Screenshot';
    }
}

async function captureSingleScreenshot(data) {
    const body = { url: data.get('url') };

    ['width', 'height', 'waitTime', 'output_width', 'output_quality'].forEach(f => {
        const v = data.get(f);
        if (v) body[f] = parseInt(v);
    });

    if (data.get('output_format')) body.output_format = data.get('output_format');

    const res = await fetch('/shot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || 'Screenshot failed');
    }

    const contentType = res.headers.get('Content-Type');
    let extension = 'png';

    if (contentType === 'image/webp') extension = 'webp';
    else if (contentType === 'image/jpeg') extension = 'jpg';

    currentFilename = `screenshot-${Date.now()}.${extension}`;
    screenshotBlob = await res.blob();
    document.getElementById('screenshot-img').src = URL.createObjectURL(screenshotBlob);
    document.getElementById('result-container').classList.add('visible');
    document.getElementById('result-container-multi').classList.remove('visible');
    scrollToResult();
}

async function captureMultiScreenshot(data) {
    const body = { url: data.get('url') };

    ['width', 'waitTime'].forEach(f => {
        const v = data.get(f);
        if (v) body[f] = parseInt(v);
    });

    const height = data.get('height');
    if (height) body.maxHeight = parseInt(height);

    if (data.get('output_format')) body.output_format = data.get('output_format');
    if (data.get('output_quality')) body.output_quality = parseInt(data.get('output_quality'));

    const outputs = outputConfigs.map(c => ({
        height: c.height ? parseInt(c.height) : null,
        output_width: c.output_width ? parseInt(c.output_width) : null
    })).filter(o => o.height || o.output_width);

    if (outputs.length === 0) {
        throw new Error('Please specify height or output_width for each output configuration');
    }

    body.outputs = outputs;

    const res = await fetch('/shot-multi', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || 'Multi screenshot failed');
    }

    const result = await res.json();
    displayMultiResults(result.images);
}

function displayMultiResults(images) {
    multiImages = images;
    const container = document.getElementById('multi-results');
    container.innerHTML = images.map((img, i) => {
        const ext = img.content_type === 'image/webp' ? 'webp'
                    : img.content_type === 'image/jpeg' ? 'jpg' : 'png';
        const filename = `screenshot-${i + 1}_${img.width}x${img.height}.${ext}`;

        return `
            <div class="multi-result">
                <div class="multi-result-header">
                    <span>${img.width} × ${img.height}</span>
                    <button class="btn btn-sm btn-secondary" data-index="${i}" onclick="downloadMultiImage(${i})">
                        ⬇️ Download
                    </button>
                </div>
                <img src="data:${img.content_type};base64,${img.data}" alt="Screenshot ${i + 1}">
            </div>
        `;
    }).join('');

    document.getElementById('result-container-multi').classList.add('visible');
    document.getElementById('result-container').classList.remove('visible');
    scrollToResult();
}

function downloadMultiImage(index) {
    const img = multiImages[index];
    if (!img) return;

    const ext = img.content_type === 'image/webp' ? 'webp'
                : img.content_type === 'image/jpeg' ? 'jpg' : 'png';
    const filename = `screenshot-${index + 1}_${img.width}x${img.height}.${ext}`;
    const byteCharacters = atob(img.data);
    const byteArrays = [];

    for (let offset = 0; offset < byteCharacters.length; offset += 512) {
        const slice = byteCharacters.slice(offset, offset + 512);
        const byteNumbers = new Array(slice.length);
        for (let i = 0; i < slice.length; i++) {
            byteNumbers[i] = slice.charCodeAt(i);
        }
        byteArrays.push(new Uint8Array(byteNumbers));
    }

    const blob = new Blob(byteArrays, { type: img.content_type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
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
    document.getElementById('result-container-multi').classList.remove('visible');
    document.getElementById('url').focus();
    screenshotBlob = null;
    multiImages = [];
}

function scrollToResult() {
    const container = currentMode === 'multi'
        ? document.getElementById('result-container-multi')
        : document.getElementById('result-container');
    container.scrollIntoView({ behavior: 'smooth' });
}

document.getElementById('screenshot-form').addEventListener('submit', captureScreenshot);