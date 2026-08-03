// settings.js
import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';

export const MODULE_NAME = 'expression_router';

export const DEFAULT_PROMPT = `You are an expression classifier for a roleplay character.

Available expressions:
{{labels}}

Conversation (most recent last):
{{history}}

Reply ONLY with ONE expression from the list above. Nothing else.`;

const DEFAULT_SETTINGS = {
    enabled: false,
    connectionProfile: '',
    prompt: DEFAULT_PROMPT,
    historyCount: 4,
    temperature: 0,
    maxTokens: 64,
    debugPrompt: false,
    debugResponse: false,
    suppressClassifier: true,
    uiCollapsed: false,
    hidePrompt: false,
    fallbackExpression: 'neutral',
    holdToHideChat: false,
};

export function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
    }

    const settings = extension_settings[MODULE_NAME];

    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (!(key in settings)) {
            settings[key] = structuredClone(value);
        }
    }

    return settings;
}

export function saveSettings() {
    if (typeof saveSettingsDebounced === 'function') {
        saveSettingsDebounced();
    }
}

export function updateSetting(key, value) {
    const settings = getSettings();
    settings[key] = value;
    saveSettings();
}

export function resetPrompt() {
    updateSetting('prompt', DEFAULT_PROMPT);
    return DEFAULT_PROMPT;
}

export function getConnectionProfiles() {
    return extension_settings?.connectionManager?.profiles || [];
}

export function listConnectionProfiles() {
    return getConnectionProfiles().map(p => ({
        id: p.id,
        name: p.name,
    }));
}

export function findConnectionProfile(id) {
    if (!id) return null;
    const profiles = getConnectionProfiles();
    return (
        profiles.find(p => p.id === id) ||
        profiles.find(p => p.name === id) ||
        null
    );
}
