// classifier.js
import { getSettings, findConnectionProfile } from './settings.js';
import { getAvailableLabels, hasLabel, normalizeLabel } from './sprites.js';
import { setLastExpression } from './wrappers.js';
import { expandWrappers } from './wrappers.js';
import { sidecarGenerate, isSidecarConfigured } from './llm-sidecar.js';

export async function classifyExpression() {
    const settings = getSettings();
    if (!settings.enabled) return null;

    if (!isSidecarConfigured()) {
        console.warn('[Expression Router] No valid Connection Profile.');
        return null;
    }

    await getAvailableLabels();

    let prompt = await expandWrappers(settings.prompt || '');

    if (settings.debugPrompt) {
        console.log('[Expression Router] Prompt:\n', prompt);
    }

    let raw;
    try {
        raw = await sidecarGenerate({
            prompt,
            systemPrompt:
                'You are a classifier. Reply with EXACTLY one expression label from the list. ' +
                'One word only. No explanation. No markdown. No thinking.',
        });
    } catch (e) {
        console.error('[Expression Router] Generation error:', e);
        throw e;
    }

    // Strip think blocks early — not part of the answer
    raw = String(raw || '')
        .replace(/<think[\s\S]*?<\/think>/gi, '')
        .replace(/```[\s\S]*?```/g, '')
        .trim();

    if (settings.debugResponse) {
        console.log('[Expression Router] Raw response:', raw);
    }

    if (!raw) {
        throw new Error('Model returned an empty response.');
    }

    const labels = window.expressionRouterLabels || [];
    const parsed = parseResponse(raw);

    if (parsed) {
        if (hasLabel(parsed)) {
            setLastExpression(parsed);
            return parsed;
        }
        const normalized = normalizeLabel(parsed);
        if (normalized) {
            setLastExpression(normalized);
            return normalized;
        }
    }

    // Last short line that is exactly a label
    const lines = raw
        .split('\n')
        .map(l => l.replace(/^[\s*#\-\d.]+/, '').replace(/^["'`]+|["'`]+$/g, '').trim())
        .filter(Boolean);

    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (hasLabel(line)) {
            setLastExpression(line);
            return line;
        }
        const n = normalizeLabel(line);
        if (n) {
            setLastExpression(n);
            return n;
        }
    }

    // Whole-word match anywhere (longer labels first)
    const sorted = [...labels].sort((a, b) => b.length - a.length);
    const lowerRaw = raw.toLowerCase();
    for (const label of sorted) {
        const re = new RegExp(
            `(?:^|[^a-z0-9_])${escapeRegExp(label)}(?:[^a-z0-9_]|$)`,
            'i',
        );
        if (re.test(lowerRaw)) {
            setLastExpression(label);
            return label;
        }
    }

    throw new Error(
        `Invalid expression "${parsed || '(none)'}" (not in character labels). Raw: ${raw.slice(0, 160)}`,
    );
}

function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseResponse(text) {
    if (!text || typeof text !== 'string') return null;

    let cleaned = text.trim();

    try {
        const json = JSON.parse(cleaned);
        if (json.expression) return String(json.expression).trim();
        if (json.label) return String(json.label).trim();
    } catch { /* not JSON */ }

    const lines = cleaned
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0);

    if (!lines.length) return null;

    // Prefer LAST line (answer often at the end)
    let line = lines[lines.length - 1]
        .replace(/^[\s*#\-\d.]+/, '')
        .replace(/^["'`]+/, '')
        .replace(/["'`]+$/, '')
        .trim();

    if (line.length > 40 && lines.length > 1) {
        const first = lines[0]
            .replace(/^[\s*#\-\d.]+/, '')
            .replace(/^["'`]+/, '')
            .replace(/["'`]+$/, '')
            .trim();
        if (first.length <= 40) return first;
    }

    return line;
}
