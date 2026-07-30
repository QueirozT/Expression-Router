// sprites.js
import { getContext, extension_settings } from '../../../extensions.js';
import { getRequestHeaders } from '../../../../script.js';
import { setLabels } from './wrappers.js';

let cache = {
    folder: null,
    labels: [],
};

/**
 * Resolve the sprite folder name (respects expression overrides).
 */
export function getSpriteFolderName() {
    const context = getContext();
    let folderName = context.name2 || null;

    const charId = context.characterId;
    if (charId !== undefined && charId !== null) {
        const char = context.characters?.[charId];
        if (char?.avatar) {
            const avatarKey = char.avatar.replace(/\.[^/.]+$/, '');
            const override = extension_settings.expressionOverrides?.find(e => e.name === avatarKey);
            if (override?.path) {
                folderName = override.path;
            }
        }
    }

    return folderName;
}

export async function getAvailableLabels(force = false) {
    const folder = getSpriteFolderName();
    if (!folder) {
        cache = { folder: null, labels: [] };
        setLabels([]);
        return [];
    }

    if (!force && cache.folder === folder && cache.labels.length) {
        return cache.labels;
    }

    try {
        const res = await fetch(`/api/sprites/get?name=${encodeURIComponent(folder)}`, {
            method: 'GET',
            headers: getRequestHeaders(),
            cache: 'no-cache',
        });

        if (!res.ok) {
            console.error('[Expression Router] Failed to load sprites:', res.status);
            cache = { folder, labels: [] };
            setLabels([]);
            return [];
        }

        const sprites = await res.json();
        const labels = [
            ...new Set(
                sprites
                    .map(s => s.label)
                    .filter(Boolean),
            ),
        ].sort((a, b) => a.localeCompare(b));

        cache = { folder, labels };
        setLabels(labels);
        return labels;
    } catch (e) {
        console.error('[Expression Router] Sprite fetch error:', e);
        return [];
    }
}

export function hasLabel(label) {
    if (!label) return false;
    return cache.labels.includes(label.trim());
}

export function normalizeLabel(label) {
    if (!label) return null;
    const lower = label.trim().toLowerCase();
    for (const existing of cache.labels) {
        if (existing.toLowerCase() === lower) return existing;
    }
    return null;
}

export function clearSpriteCache() {
    cache = { folder: null, labels: [] };
}
