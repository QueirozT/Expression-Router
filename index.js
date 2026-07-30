// index.js
import {
    eventSource,
    event_types,
    saveSettingsDebounced,
} from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { sendExpressionCall } from '../../expressions/index.js';

import {
    getSettings,
    updateSetting,
    listConnectionProfiles,
    resetPrompt,
    DEFAULT_PROMPT,
} from './settings.js';
import { classifyExpression } from './classifier.js';
import {
    getAvailableLabels,
    getSpriteFolderName,
    clearSpriteCache,
} from './sprites.js';
import { isSidecarConfigured, isSidecarKeyAvailable } from './llm-sidecar.js';

const MODULE = 'Expression Router';

let panel = null;
let _classifying = false;

// ─── Classifier suppression (optional) ───────────────────────────

function suppressClassifier() {
    const settings = getSettings();
    if (!settings.suppressClassifier) return;
    if (!extension_settings.expressions) return;

    if (!settings._classifierSnapshot) {
        settings._classifierSnapshot = {
            api: extension_settings.expressions.api ?? null,
        };
        saveSettingsDebounced();
    }
    extension_settings.expressions.api = 99; // none
}

function restoreClassifier() {
    const settings = getSettings();
    if (!settings._classifierSnapshot || !extension_settings.expressions) return;
    extension_settings.expressions.api = settings._classifierSnapshot.api;
    settings._classifierSnapshot = null;
    saveSettingsDebounced();
}

// ─── Apply expression ────────────────────────────────────────────

async function applyExpression(expression) {
    const folder = getSpriteFolderName();
    if (!folder || !expression) return;

    try {
        await sendExpressionCall(folder, expression, { force: true });
        // Keep ST's fallback in sync so moduleWorker doesn't overwrite
        if (extension_settings.expressions) {
            extension_settings.expressions.fallback_expression = expression;
        }
    } catch (e) {
        console.error(`[${MODULE}] applyExpression failed:`, e);
        throw e;
    }
}

// ─── Main classification hook ────────────────────────────────────

async function onMessageReceived() {
    const settings = getSettings();
    if (!settings.enabled || _classifying) return;

    _classifying = true;
    try {
        const expression = await classifyExpression();
        if (expression) {
            await applyExpression(expression);
            setStatus(`Selected: ${expression}`, 'ok');
        }
    } catch (e) {
        setStatus(e.message || 'Classification failed', 'error');
        showOutput(String(e.message || e));
    } finally {
        _classifying = false;
    }
}

// ─── UI ──────────────────────────────────────────────────────────

function escapeHtml(text) {
    return String(text ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function createUI() {
    const settings = getSettings();

    const html = `
<div class="er_block">
    <div class="er_header">
        <i class="fa-solid fa-masks-theater"></i>
        <span>Expression Router</span>
        <span class="er_version">v1.0</span>
    </div>

    <div class="er_row">
        <label class="er_toggle">
            <input id="er_enabled" type="checkbox" ${settings.enabled ? 'checked' : ''}>
            <span>Enabled</span>
        </label>
    </div>

    <div class="er_row">
        <label>Connection Profile</label>
        <select id="er_profile"></select>
    </div>

    <div class="er_row">
        <label>History messages</label>
        <input id="er_history" type="number" min="0" max="50" value="${settings.historyCount}">
    </div>

    <div class="er_row">
        <label>Temperature</label>
        <input id="er_temp" type="number" min="0" max="2" step="0.05" value="${settings.temperature}">
    </div>

    <div class="er_row">
        <label>Max tokens</label>
        <input id="er_maxtokens" type="number" min="8" max="256" value="${settings.maxTokens}">
    </div>

    <div class="er_row">
        <label class="er_toggle">
            <input id="er_suppress" type="checkbox" ${settings.suppressClassifier ? 'checked' : ''}>
            <span>Suppress ST built-in classifier</span>
        </label>
    </div>

    <label class="er_label">Prompt <span class="er_hint">(wrappers: {{labels}} {{history}} {{history:N}} {{last_char}} {{last_user}} {{last_message}} {{char}} {{user}})</span></label>
    <textarea id="er_prompt" class="er_prompt" rows="12">${escapeHtml(settings.prompt)}</textarea>

    <div class="er_btn_row">
        <button id="er_reset_prompt" class="menu_button">Reset prompt</button>
        <button id="er_test" class="menu_button">Test classification</button>
        <button id="er_refresh_labels" class="menu_button">Refresh labels</button>
    </div>

    <div class="er_debug">
        <label><input id="er_debug_prompt" type="checkbox" ${settings.debugPrompt ? 'checked' : ''}> Log prompt</label>
        <label><input id="er_debug_response" type="checkbox" ${settings.debugResponse ? 'checked' : ''}> Log response</label>
    </div>

    <div id="er_status" class="er_status waiting">Ready</div>
    <div id="er_output" class="er_output er_hidden"></div>
    <div id="er_labels_preview" class="er_labels_preview"></div>
</div>
`;

    panel = $(html);
    $('#extensions_settings2').append(panel);
    bindEvents();
    refreshProfiles();
    refreshLabelsPreview();
}

function bindEvents() {
    panel.find('#er_enabled').on('change', function () {
        updateSetting('enabled', this.checked);
        if (this.checked) {
            suppressClassifier();
            setStatus('Enabled', 'ok');
        } else {
            restoreClassifier();
            setStatus('Disabled', 'waiting');
        }
    });

    panel.find('#er_profile').on('change', function () {
        updateSetting('connectionProfile', this.value);
        setStatus(this.value ? 'Profile selected' : 'No profile', this.value ? 'ok' : 'error');
    });

    panel.find('#er_history').on('change', function () {
        const n = Math.max(0, Math.min(50, Number(this.value) || 0));
        this.value = n;
        updateSetting('historyCount', n);
    });

    panel.find('#er_temp').on('change', function () {
        const v = Math.max(0, Math.min(2, Number(this.value) || 0.2));
        this.value = v;
        updateSetting('temperature', v);
    });

    panel.find('#er_maxtokens').on('change', function () {
        const v = Math.max(8, Math.min(256, Number(this.value) || 32));
        this.value = v;
        updateSetting('maxTokens', v);
    });

    panel.find('#er_suppress').on('change', function () {
        updateSetting('suppressClassifier', this.checked);
        if (getSettings().enabled) {
            if (this.checked) suppressClassifier();
            else restoreClassifier();
        }
    });

    panel.find('#er_prompt').on('input', function () {
        updateSetting('prompt', this.value);
    });

    panel.find('#er_debug_prompt').on('change', function () {
        updateSetting('debugPrompt', this.checked);
    });

    panel.find('#er_debug_response').on('change', function () {
        updateSetting('debugResponse', this.checked);
    });

    panel.find('#er_reset_prompt').on('click', () => {
        const p = resetPrompt();
        panel.find('#er_prompt').val(p);
        setStatus('Prompt reset to default', 'ok');
    });

    panel.find('#er_refresh_labels').on('click', async () => {
        clearSpriteCache();
        await getAvailableLabels(true);
        refreshLabelsPreview();
        setStatus('Labels refreshed', 'ok');
    });

    panel.find('#er_test').on('click', async () => {
        setStatus('Classifying...', 'waiting');
        showOutput('');
        try {
            if (!isSidecarConfigured()) {
                throw new Error('Select a valid Connection Profile first (API + model).');
            }
            if (!isSidecarKeyAvailable()) {
                throw new Error('API key access denied. Enable allowKeysExposure in config.yaml.');
            }

            const expression = await classifyExpression();
            showOutput(expression || '(no valid expression)');
            setStatus(
                expression ? `Selected: ${expression}` : 'No valid expression returned',
                expression ? 'ok' : 'error',
            );

            if (expression) {
                await applyExpression(expression);
            }
        } catch (e) {
            showOutput(String(e.message || e));
            setStatus(e.message || 'Error', 'error');
        }
    });
}

function refreshProfiles() {
    const select = panel.find('#er_profile');
    select.empty();
    select.append($('<option>').val('').text('— select profile —'));

    for (const p of listConnectionProfiles()) {
        select.append($('<option>').val(p.id).text(p.name));
    }

    select.val(getSettings().connectionProfile || '');
}

async function refreshLabelsPreview() {
    const labels = await getAvailableLabels(true);
    const box = panel.find('#er_labels_preview');
    if (!labels.length) {
        box.text('No sprites found for current character.');
    } else {
        box.text(`Labels (${labels.length}): ${labels.join(', ')}`);
    }
}

function setStatus(text, type) {
    if (!panel) return;
    panel.find('#er_status')
        .removeClass('ok error waiting')
        .addClass(type)
        .text(text);
}

function showOutput(text) {
    if (!panel) return;
    const out = panel.find('#er_output');
    if (!text) {
        out.addClass('er_hidden').text('');
        return;
    }
    out.removeClass('er_hidden').text(text);
}

// ─── Init ────────────────────────────────────────────────────────

jQuery(async () => {
    getSettings();
    createUI();

    if (getSettings().enabled) {
        suppressClassifier();
    }

    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);

    eventSource.on(event_types.CHAT_CHANGED, async () => {
        clearSpriteCache();
        await getAvailableLabels(true);
        refreshLabelsPreview();
        refreshProfiles();
    });

    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, async () => {
        await getAvailableLabels(true);
    });

    // Re-populate profiles if Connection Manager changes (best-effort)
    setInterval(() => {
        if (panel?.length) refreshProfiles();
    }, 15000);

    console.log(`[${MODULE}] loaded.`);
});
