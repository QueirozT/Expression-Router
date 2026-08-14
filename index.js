// index.js
import {
    eventSource,
    event_types,
    saveSettingsDebounced,
} from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { sendExpressionCall } from '../../expressions/index.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { getContext } from '../../../st-context.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from '../../../slash-commands/SlashCommandArgument.js';

import {
    getSettings,
    updateSetting,
    listConnectionProfiles,
    resetPrompt,
} from './settings.js';
import { classifyExpression } from './classifier.js';
import {
    getAvailableLabels,
    getSpriteFolderName,
    clearSpriteCache,
} from './sprites.js';
import { setLastExpression, getLastExpression } from './wrappers.js';
import { isSidecarConfigured, isSidecarKeyAvailable } from './llm-sidecar.js';

const MODULE = 'Expression Router';
const EXPR_KEY = 'expression_router';

let panel = null;
let _classifying = false;

// ─── Per-message / per-swipe expression storage ─────────────────

function ensureMesExtra(mes) {
    if (!mes.extra || typeof mes.extra !== 'object') mes.extra = {};
    return mes.extra;
}

function ensureSwipeInfoExtra(mes, swipeId) {
    if (!Array.isArray(mes.swipe_info)) mes.swipe_info = [];
    if (!mes.swipe_info[swipeId] || typeof mes.swipe_info[swipeId] !== 'object') {
        mes.swipe_info[swipeId] = {};
    }
    if (!mes.swipe_info[swipeId].extra || typeof mes.swipe_info[swipeId].extra !== 'object') {
        mes.swipe_info[swipeId].extra = {};
    }
    return mes.swipe_info[swipeId].extra;
}

/** Expression saved on this message (current swipe). */
function getMessageExpression(mes) {
    if (!mes) return '';
    const fromExtra = mes.extra?.[EXPR_KEY];
    if (typeof fromExtra === 'string' && fromExtra) return fromExtra;
    const sid = typeof mes.swipe_id === 'number' ? mes.swipe_id : 0;
    const fromSwipe = mes.swipe_info?.[sid]?.extra?.[EXPR_KEY];
    if (typeof fromSwipe === 'string' && fromSwipe) return fromSwipe;
    return '';
}

/**
 * Write expression onto the message + current swipe.
 * Also keeps chat-level meta for quick restore / older chats.
 */
function setMessageExpression(mesId, expression) {
    const ctx = getContext();
    const chat = ctx.chat;
    if (!chat || mesId == null || mesId < 0 || mesId >= chat.length) return;

    const mes = chat[mesId];
    if (!mes || mes.is_user || mes.is_system) return;

    const label = expression || '';
    ensureMesExtra(mes)[EXPR_KEY] = label;

    const sid = typeof mes.swipe_id === 'number' ? mes.swipe_id : 0;
    ensureSwipeInfoExtra(mes, sid)[EXPR_KEY] = label;

    // Compat: last known for this chat
    const meta = ctx.chatMetadata || ctx.chat_metadata;
    if (meta) {
        meta.expression_router = { expression: label, updatedAt: Date.now() };
        try {
            if (typeof ctx.saveMetadata === 'function') ctx.saveMetadata();
        } catch (e) {
            console.warn(`[${MODULE}] Could not save chat metadata:`, e);
        }
    }

    try {
        if (typeof ctx.saveChat === 'function') ctx.saveChat();
        else if (typeof ctx.saveChatDebounced === 'function') ctx.saveChatDebounced();
    } catch (e) {
        console.warn(`[${MODULE}] Could not save chat:`, e);
    }
}

function findLastCharacterMesId() {
    const chat = getContext().chat || [];
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (m && !m.is_user && !m.is_system) return i;
    }
    return -1;
}

function getChatExpressionMeta() {
    const ctx = getContext();
    const meta = ctx.chatMetadata || ctx.chat_metadata || {};
    return meta.expression_router || null;
}

// ─── Classifier suppression ──────────────────────────────────────

const EXPRESSION_API_NONE = 99;

function suppressClassifier() {
    const settings = getSettings();
    if (!settings.suppressClassifier) return;
    if (!extension_settings.expressions) return;

    const current = extension_settings.expressions.api;

    if (current !== EXPRESSION_API_NONE && settings._classifierSnapshot == null) {
        settings._classifierSnapshot = { api: current ?? null };
    }

    if (current !== EXPRESSION_API_NONE) {
        extension_settings.expressions.api = EXPRESSION_API_NONE;
        saveSettingsDebounced();
    }

    const $api = $('#expression_api');
    if ($api.length && String($api.val()) !== String(EXPRESSION_API_NONE)) {
        $api.val(String(EXPRESSION_API_NONE));
    }
}

function restoreClassifier() {
    const settings = getSettings();
    if (!extension_settings.expressions) return;

    const snap = settings._classifierSnapshot;
    if (!snap) return;

    extension_settings.expressions.api = snap.api;
    settings._classifierSnapshot = null;
    saveSettingsDebounced();

    const $api = $('#expression_api');
    if ($api.length && snap.api != null) {
        $api.val(String(snap.api));
    }
}

// ─── Apply expression ────────────────────────────────────────────

async function applyExpression(expression, mesId = null) {
    const folder = getSpriteFolderName();
    if (!folder || !expression) return;

    try {
        await sendExpressionCall(folder, expression, { force: true });
        if (extension_settings.expressions) {
            extension_settings.expressions.fallback_expression = expression;
        }
        setLastExpression(expression);

        const id = mesId != null ? mesId : findLastCharacterMesId();
        if (id >= 0) {
            setMessageExpression(id, expression);
        } else {
            const ctx = getContext();
            const meta = ctx.chatMetadata || ctx.chat_metadata;
            if (meta) {
                meta.expression_router = { expression, updatedAt: Date.now() };
                try {
                    if (typeof ctx.saveMetadata === 'function') ctx.saveMetadata();
                } catch { /* ignore */ }
            }
        }
    } catch (e) {
        console.error(`[${MODULE}] applyExpression failed:`, e);
        throw e;
    }
}

// ─── Classification ──────────────────────────────────────────────

async function runClassification({ silent = false, mesId = null } = {}) {
    const settings = getSettings();
    if (!settings.enabled) {
        if (!silent) toastr.warning('Expression Router is disabled.', MODULE);
        return null;
    }

    const ctx = getContext();
    if (!ctx?.name2 || ctx.characterId === undefined || ctx.characterId === null) {
        return null;
    }

    const labels = await getAvailableLabels(true);
    if (!labels.length) {
        if (!silent) {
            toastr.warning('No sprite labels for this character.', MODULE);
            setStatus('No labels', 'error');
            showOutput('No sprites found for current character.');
        }
        return null;
    }

    if (_classifying) return null;

    _classifying = true;
    try {
        const expression = await classifyExpression();
        if (expression) {
            await applyExpression(expression, mesId);
            setStatus(`Selected: ${expression}`, 'ok');
            return expression;
        }

        const fallback = settings.fallbackExpression;
        if (fallback) {
            await applyExpression(fallback, mesId);
            setStatus(`Fallback: ${fallback}`, 'waiting');
            showOutput(`No valid expression from model — applied fallback: ${fallback}`);
            toastr.warning(`No valid expression — fallback: ${fallback}`, MODULE);
            return fallback;
        }

        setStatus('No valid expression', 'error');
        showOutput('No valid expression returned by the model.');
        toastr.warning('No valid expression returned.', MODULE);
        return null;
    } catch (e) {
        const msg = e?.message || String(e);
        setStatus(msg, 'error');
        showOutput(msg);
        toastr.error(msg, MODULE);
        console.error(`[${MODULE}]`, e);

        const fallback = getSettings().fallbackExpression;
        if (fallback) {
            try {
                await applyExpression(fallback, mesId);
                setStatus(`Error — fallback: ${fallback}`, 'waiting');
                showOutput(`${msg}\n\nApplied fallback: ${fallback}`);
                toastr.warning(`Applied fallback: ${fallback}`, MODULE);
                return fallback;
            } catch (e2) {
                console.error(`[${MODULE}] fallback failed:`, e2);
            }
        }
        return null;
    } finally {
        _classifying = false;
    }
}

async function onMessageReceived(mesId) {
    const ctx = getContext();
    const chat = ctx.chat || [];
    const id = typeof mesId === 'number' ? mesId : findLastCharacterMesId();
    const mes = id >= 0 ? chat[id] : null;

    // Already has a sprite for this message/swipe → restore only, no LLM
    if (mes && getMessageExpression(mes)) {
        const saved = getMessageExpression(mes);
        try {
            await applyExpression(saved, id);
            setStatus(`Restored: ${saved}`, 'ok');
        } catch { /* ignore */ }
        return;
    }

    await runClassification({ silent: true, mesId: id >= 0 ? id : null });
}

async function onMessageSwiped(mesId) {
    const ctx = getContext();
    const mes = ctx.chat?.[mesId];
    if (!mes || mes.is_user || mes.is_system) return;

    // ST already swapped mes.extra from swipe_info for this swipe
    const saved = getMessageExpression(mes);
    if (!saved) return;

    try {
        await applyExpression(saved, mesId);
        setStatus(`Swipe: ${saved}`, 'ok');
    } catch (e) {
        console.warn(`[${MODULE}] Swipe restore failed:`, e);
    }
}

// ─── Slash commands ──────────────────────────────────────────────

function registerSlashCommands() {
    try {
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'er',
            aliases: ['expression-router', 'Expression-Router'],
            callback: async (args, value) => {
                const full = String(value || args?.action || '').trim();
                const parts = full.split(/\s+/).filter(Boolean);
                const action = (parts[0] || '').toLowerCase();
                const rest = parts.slice(1).join(' ').trim();

                if (action === 'reload' || action === 'classify' || action === 'run') {
                    const expr = await runClassification({ silent: false });
                    return expr || '';
                }

                if (action === 'labels' || action === 'list') {
                    const labels = await getAvailableLabels(true);
                    if (!labels.length) {
                        toastr.warning('No sprite labels for this character.', MODULE);
                    }
                    return JSON.stringify(labels);
                }

                if (action === 'current' || action === 'show') {
                    const expr = getLastExpression();
                    if (expr) {
                        toastr.info(`Current expression: ${expr}`, MODULE);
                        return expr;
                    }
                    toastr.info('No expression classified yet.', MODULE);
                    return '';
                }

                if (action === 'set' || action === 'apply') {
                    let label = String(
                        args?.label || args?.expression || rest || '',
                    ).trim();

                    if (!label && typeof value === 'string') {
                        const v = value.trim();
                        if (v && !/^(set|apply)\b/i.test(v)) {
                            label = v;
                        }
                    }

                    if (!label) {
                        toastr.warning('Usage: /er set <label>', MODULE);
                        return '';
                    }

                    const labels = await getAvailableLabels(true);
                    if (!labels.length) {
                        toastr.warning('No sprite labels for this character.', MODULE);
                        return '';
                    }

                    const match =
                        labels.find(l => l === label) ||
                        labels.find(l => l.toLowerCase() === label.toLowerCase());

                    if (!match) {
                        toastr.error(`Unknown label: ${label}`, MODULE);
                        return '';
                    }

                    await applyExpression(match);
                    setStatus(`Set: ${match}`, 'ok');
                    toastr.success(`Expression set: ${match}`, MODULE);
                    return match;
                }

                toastr.info(
                    'Usage: /er reload | /er labels | /er current | /er set <label>',
                    MODULE,
                    { timeOut: 6000 },
                );
                return '';
            },
            unnamedArgumentList: [
                SlashCommandArgument.fromProps({
                    description: 'Action: reload | labels | current | set <label>',
                    typeList: [ARGUMENT_TYPE.STRING],
                    isRequired: false,
                }),
            ],
            helpString: `
                <div>
                    <b>Expression Router</b> commands:<br>
                    <code>/er reload</code> — reclassify expression now<br>
                    <code>/er labels</code> — list available labels<br>
                    <code>/er current</code> — show last classified expression<br>
                    <code>/er set <label></code> — set expression manually (same as sprite pick)
                </div>
            `,
        }));

        console.log(`[${MODULE}] Slash commands registered (/er, /expression-router).`);
    } catch (e) {
        console.error(`[${MODULE}] Failed to register slash commands:`, e);
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

function applyHoldToHideChat(enabled) {
    document.body.classList.toggle('er-hold-hide-chat', !!enabled);
}

function syncHoldToHideChat() {
    applyHoldToHideChat(getSettings().holdToHideChat);
    bindHoldHidePrevention();
}

function bindHoldHidePrevention() {
    $(document).off('.erHoldHide');

    if (!getSettings().holdToHideChat) return;

    const selector = '#expression-holder, .expression-holder, #expression-image, img.expression, #expression-wrapper';

    $(document).on('contextmenu.erHoldHide', selector, function (e) {
        e.preventDefault();
        e.stopPropagation();
        return false;
    });

    $(document).on('touchstart.erHoldHide', selector, function () {
        // no preventDefault — keep :active working
    });

    $(document).on('touchend.erHoldHide touchcancel.erHoldHide', selector, function () {
        // cleanup if needed
    });
}

function createUI() {
    const settings = getSettings();
    const collapsed = !!settings.uiCollapsed;
    const hidePrompt = !!settings.hidePrompt;

    const html = `
<div class="er_block">
    <div class="er_header" id="er_header_toggle" title="Click to collapse/expand">
        <div class="er_header_icon"><i class="fa-solid fa-masks-theater"></i></div>
        <div class="er_header_text">
            <span class="er_header_title">Expression Router</span>
            <span class="er_header_sub">Sidecar expression classifier</span>
        </div>
        <span class="er_badge">v1.6</span>
        <i class="fa-solid fa-chevron-down er_chevron ${collapsed ? '' : 'expanded'}"></i>
    </div>

    <div class="er_body" style="${collapsed ? 'display:none' : ''}">

        <div class="er_card">
            <div class="er_row">
                <label class="er_toggle">
                    <input id="er_enabled" type="checkbox" ${settings.enabled ? 'checked' : ''}>
                    <span class="er_toggle_slider"></span>
                    <span>Enabled</span>
                </label>
            </div>

            <div class="er_row">
                <label class="er_field_label">Connection Profile</label>
                <select id="er_profile" class="er_select"></select>
            </div>
            
            <div class="er_row">
                <label class="er_field_label">Fallback expression</label>
                <select id="er_fallback" class="er_select"></select>
            </div>

            <div class="er_row_grid">
                <div class="er_field">
                    <label class="er_field_label">History</label>
                    <input id="er_history" class="er_input" type="number" min="0" max="50" value="${settings.historyCount}">
                </div>
                <div class="er_field">
                    <label class="er_field_label">Temperature</label>
                    <input id="er_temp" class="er_input" type="number" min="0" max="2" step="0.05" value="${settings.temperature}">
                </div>
                <div class="er_field">
                    <label class="er_field_label">Max tokens</label>
                    <input id="er_maxtokens" class="er_input" type="number" min="8" max="1024" value="${settings.maxTokens}">
                </div>
            </div>

            <div class="er_row">
                <label class="er_toggle">
                    <input id="er_suppress" type="checkbox" ${settings.suppressClassifier ? 'checked' : ''}>
                    <span class="er_toggle_slider"></span>
                    <span>Suppress ST classifier</span>
                </label>
            </div>
            
            <div class="er_row">
                <label class="er_toggle">
                    <input id="er_hold_hide" type="checkbox" ${settings.holdToHideChat ? 'checked' : ''}>
                    <span class="er_toggle_slider"></span>
                    <span>Hold sprite to hide chat</span>
                </label>
            </div>
        </div>

        <div class="er_card">
            <div class="er_card_header">
                <span>Prompt</span>
                <label class="er_toggle er_toggle_sm">
                    <input id="er_hide_prompt" type="checkbox" ${hidePrompt ? 'checked' : ''}>
                    <span class="er_toggle_slider"></span>
                    <span>Hide</span>
                </label>
            </div>
            <div id="er_prompt_wrap" style="${hidePrompt ? 'display:none' : ''}">
                <div class="er_hint">
                    Wrappers: <code>{{labels}}</code> <code>{{labels_inline}}</code> <code>{{history}}</code>
                    <code>{{history:N}}</code> <code>{{last_char}}</code> <code>{{last_user}}</code>
                    <code>{{last_message}}</code> <code>{{expression}}</code> <code>{{char}}</code> <code>{{user}}</code>
                </div>
                <textarea id="er_prompt" class="er_prompt" rows="10">${escapeHtml(settings.prompt)}</textarea>
            </div>
        </div>

        <div class="er_btn_row">
            <button id="er_test" class="er_btn er_btn_primary"><i class="fa-solid fa-play"></i> Test</button>
            <button id="er_reload" class="er_btn"><i class="fa-solid fa-rotate"></i> Reload</button>
            <button id="er_reset_prompt" class="er_btn"><i class="fa-solid fa-undo"></i> Reset prompt</button>
            <button id="er_refresh_labels" class="er_btn"><i class="fa-solid fa-arrows-rotate"></i></button>
        </div>

        <div class="er_debug">
            <label class="er_check"><input id="er_debug_prompt" type="checkbox" ${settings.debugPrompt ? 'checked' : ''}> Log prompt</label>
            <label class="er_check"><input id="er_debug_response" type="checkbox" ${settings.debugResponse ? 'checked' : ''}> Log response</label>
        </div>

        <div id="er_status" class="er_status waiting">Ready</div>
        <div id="er_output" class="er_output er_hidden"></div>
        <div id="er_labels_preview" class="er_labels_preview"></div>

        <div class="er_hint er_commands_hint">
            Commands: <code>/er reload</code> · <code>/er set <label></code> · <code>/er current</code>
        </div>
    </div>
</div>
`;

    panel = $(html);
    $('#extensions_settings2').append(panel);
    bindEvents();
    refreshProfiles();
    refreshLabelsPreview();
    refreshFallbackOptions();
    updateControlsState();
}

function bindEvents() {
    panel.find('#er_header_toggle').on('click', function () {
        const body = panel.find('.er_body');
        const chevron = panel.find('.er_chevron');
        const isHidden = body.is(':hidden');
        body.slideToggle(180);
        chevron.toggleClass('expanded', isHidden);
        updateSetting('uiCollapsed', !isHidden);
    });

    panel.find('#er_hold_hide').on('change', function () {
        updateSetting('holdToHideChat', this.checked);
        applyHoldToHideChat(this.checked);
        bindHoldHidePrevention();
        setStatus(this.checked ? 'Hold-to-hide enabled' : 'Hold-to-hide disabled', 'ok');
    });

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
        if (this.value) {
            setStatus('Profile selected', 'ok');
        } else {
            setStatus('No profile', 'error');
            toastr.warning('Select a Connection Profile', MODULE);
        }
    });

    panel.find('#er_history').on('change', function () {
        const n = Math.max(0, Math.min(50, Number(this.value) || 0));
        this.value = n;
        updateSetting('historyCount', n);
    });

    panel.find('#er_temp').on('change', function () {
        const raw = Number(this.value);
        const v = Number.isFinite(raw) ? Math.max(0, Math.min(2, raw)) : 0.2;
        this.value = v;
        updateSetting('temperature', v);
    });

    panel.find('#er_maxtokens').on('change', function () {
        const v = Math.max(8, Math.min(1024, Number(this.value) || 32));
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

    panel.find('#er_hide_prompt').on('change', function () {
        updateSetting('hidePrompt', this.checked);
        panel.find('#er_prompt_wrap').slideToggle(150);
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
        setStatus('Prompt reset', 'ok');
        toastr.info('Prompt reset to default', MODULE);
    });

    panel.find('#er_refresh_labels').on('click', async () => {
        clearSpriteCache();
        await getAvailableLabels(true);
        refreshLabelsPreview();
        await refreshFallbackOptions();
        setStatus('Labels refreshed', 'ok');
        toastr.success('Labels refreshed', MODULE);
    });

    panel.find('#er_test, #er_reload').on('click', async () => {
        setStatus('Classifying...', 'waiting');
        showOutput('');
        try {
            if (!isSidecarConfigured()) {
                throw new Error('Select a valid Connection Profile (API + model).');
            }
            if (!isSidecarKeyAvailable()) {
                throw new Error('API key access denied. Enable allowKeysExposure in config.yaml.');
            }
            const expression = await runClassification({ silent: false });
            if (expression) {
                showOutput(expression);
                toastr.success(`Selected: ${expression}`, MODULE);
            }
        } catch (e) {
            const msg = e?.message || String(e);
            showOutput(msg);
            setStatus(msg, 'error');
            toastr.error(msg, MODULE);
        }
    });

    panel.find('#er_fallback').on('change', function () {
        updateSetting('fallbackExpression', this.value || '');
        setStatus(this.value ? `Fallback: ${this.value}` : 'No fallback', 'ok');
    });
}

function refreshProfiles() {
    if (!panel?.length) return;
    const select = panel.find('#er_profile');
    const current = getSettings().connectionProfile || '';
    select.empty();
    select.append($('<option>').val('').text('— select profile —'));
    for (const p of listConnectionProfiles()) {
        select.append($('<option>').val(p.id).text(p.name));
    }
    select.val(current);
}

async function refreshLabelsPreview() {
    if (!panel?.length) return;
    const labels = await getAvailableLabels(true);
    const box = panel.find('#er_labels_preview');
    if (!labels.length) {
        box.text('No sprites found for current character.');
    } else {
        box.html(`<b>${labels.length} labels:</b> ${escapeHtml(labels.join(', '))}`);
    }
}

function setStatus(text, type) {
    if (!panel?.length) return;
    panel.find('#er_status')
        .removeClass('ok error waiting')
        .addClass(type)
        .text(text);
}

function showOutput(text) {
    if (!panel?.length) return;
    const out = panel.find('#er_output');
    if (!text) {
        out.addClass('er_hidden').text('');
        return;
    }
    out.removeClass('er_hidden').text(text);
}

function updateControlsState() {
    if (!panel?.length) return;

    const context = getContext();
    const hasChat = context?.characterId !== undefined
        && context?.characterId !== null
        && !!context?.name2;

    const buttons = panel.find('#er_test, #er_reload, #er_refresh_labels');
    buttons.prop('disabled', !hasChat);
    buttons.toggleClass('er_btn_disabled', !hasChat);

    if (!hasChat) {
        panel.find('#er_labels_preview').text('Open a chat to use classification and labels.');
        panel.find('#er_fallback').prop('disabled', true);
    } else {
        panel.find('#er_fallback').prop('disabled', false);
    }
}

async function refreshFallbackOptions() {
    if (!panel?.length) return;
    const select = panel.find('#er_fallback');
    const current = getSettings().fallbackExpression || 'neutral';
    const labels = await getAvailableLabels(false);

    select.empty();
    select.append($('<option>').val('').text('— none —'));

    if (!labels.length) {
        select.val('');
        return;
    }

    for (const label of labels) {
        select.append($('<option>').val(label).text(label));
    }

    if (labels.includes(current) || current === '') {
        select.val(current);
    } else {
        select.val(labels.includes('neutral') ? 'neutral' : '');
    }
}

// ─── Init ────────────────────────────────────────────────────────

jQuery(async () => {
    const s = getSettings();
    if (s.uiCollapsed === undefined) s.uiCollapsed = false;
    if (s.hidePrompt === undefined) s.hidePrompt = false;

    createUI();
    syncHoldToHideChat();
    registerSlashCommands();

    if (getSettings().enabled) {
        suppressClassifier();
    }

    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.MESSAGE_SWIPED, onMessageSwiped);

    eventSource.on(event_types.CHAT_CHANGED, async () => {
        clearSpriteCache();
        setLastExpression('');
        await getAvailableLabels(true);
        refreshLabelsPreview();
        await refreshFallbackOptions();
        refreshProfiles();
        updateControlsState();
        syncHoldToHideChat();

        if (getSettings().enabled && getSettings().suppressClassifier) {
            suppressClassifier();
        }

        const ctx = getContext();
        if (!ctx?.name2 || ctx.characterId === undefined || ctx.characterId === null) {
            return;
        }

        const labels = await getAvailableLabels(false);
        if (!labels.length) {
            return;
        }

        const lastId = findLastCharacterMesId();
        const chat = ctx.chat || [];
        const lastMes = lastId >= 0 ? chat[lastId] : null;

        // 1) per-message / current swipe
        let saved = lastMes ? getMessageExpression(lastMes) : '';

        // 2) legacy chat-level meta
        if (!saved) {
            saved = getChatExpressionMeta()?.expression || '';
        }

        if (saved) {
            try {
                await applyExpression(saved, lastId >= 0 ? lastId : null);
                setStatus(`Restored: ${saved}`, 'ok');
                return;
            } catch (e) {
                console.warn(`[${MODULE}] Restore failed:`, e);
            }
        }

        // 3) fallback only — and persist onto the message so reopen won't re-classify
        const fallback = getSettings().fallbackExpression;
        if (fallback) {
            try {
                await applyExpression(fallback, lastId >= 0 ? lastId : null);
                setStatus(`Fallback: ${fallback}`, 'waiting');
            } catch { /* ignore */ }
        }
    });

    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, async () => {
        await getAvailableLabels(true);
    });

    setInterval(() => {
        if (panel?.length) refreshProfiles();
    }, 20000);

    console.log(`[${MODULE}] loaded.`);
});
