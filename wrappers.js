// wrappers.js
import { getContext } from '../../../st-context.js';
import { getSettings } from './settings.js';

const WRAPPER_RE = /\{\{\s*([a-zA-Z0-9_]+)(?::(\d+))?\s*\}\}/g;

let currentLabels = [];

export function setLabels(labels) {
    currentLabels = [...(labels || [])];
}

export function getLabels() {
    return currentLabels.join('\n');
}

export async function expandWrappers(prompt) {
    const context = getContext();
    return prompt.replace(WRAPPER_RE, (_, name, value) =>
        resolveWrapper(name.toLowerCase(), value, context),
    );
}

function resolveWrapper(name, value, context) {
    switch (name) {
        case 'labels':
            return getLabels();

        case 'last_char':
            return getLastCharacterMessage(context);

        case 'last_user':
            return getLastUserMessage(context);

        case 'last_message':
            return getLastMessage(context);

        case 'history': {
            const count = value
                ? Number(value)
                : (getSettings().historyCount ?? 6);
            return getHistory(context, count);
        }

        case 'char':
            return context.name2 || 'Character';

        case 'user':
            return context.name1 || 'User';

        default:
            return `{{${name}${value ? ':' + value : ''}}}`;
    }
}

function getLastCharacterMessage(context) {
    const msg = [...(context.chat || [])]
        .reverse()
        .find(m => !m.is_user && !m.is_system);
    return msg?.mes || '';
}

function getLastUserMessage(context) {
    const msg = [...(context.chat || [])]
        .reverse()
        .find(m => m.is_user);
    return msg?.mes || '';
}

function getLastMessage(context) {
    return context.chat?.at(-1)?.mes || '';
}

function getHistory(context, amount) {
    const n = Math.max(0, Math.min(50, Number(amount) || 6));
    const history = (context.chat || [])
        .filter(m => !m.is_system && m.mes)
        .slice(-n);

    return history
        .map(m => {
            const role = m.is_user ? (context.name1 || 'User') : (m.name || context.name2 || 'Character');
            return `${role}: ${m.mes}`;
        })
        .join('\n\n');
}
