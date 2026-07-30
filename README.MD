# Expression Router

LLM-based sprite expression classifier for SillyTavern.

Uses a **Connection Profile** (API + key already saved in ST) as a sidecar, so classification does not consume the main chat model or its context window.

---

## What it does

After each character message, Expression Router:

1. Builds a prompt with the expressions available for the current character and recent chat history  
2. Calls the model from the selected Connection Profile  
3. Validates that the reply is one of the character’s sprite labels  
4. Applies the expression via SillyTavern’s sprite system  

You fully control the prompt. No fixed emotion taxonomy — only the labels that exist as images in the character’s sprite folder.

---

## Requirements

- SillyTavern with the **Expressions (Sprites)** extension enabled  
- At least one **Connection Profile** configured (API source + model)  
- `allowKeysExposure: true` in SillyTavern’s `config.yaml` (needed to read the profile’s API key, same as other sidecar extensions)  
- Character sprites present under the character’s sprite folder  

---

## Settings

| Setting | Description |
|--------|-------------|
| **Enabled** | Turns automatic classification on/off |
| **Connection Profile** | Which saved profile (API + key + model) is used as the sidecar |
| **History** | How many recent non-system messages are injected via `{{history}}` |
| **Temperature** | Sampling temperature for the sidecar call |
| **Max tokens** | Max tokens for the sidecar reply (keep low; you only need one label) |
| **Suppress ST classifier** | Sets ST’s built-in expression API to “None” so it does not overwrite this extension’s picks |
| **Prompt** | Full classification prompt (editable). Supports wrappers below |
| **Hide prompt** | Collapses the prompt editor in the UI |
| **Log prompt / Log response** | Writes expanded prompt and raw model reply to the browser console |
| **Header click** | Collapses or expands the whole settings panel |

Buttons:

- **Test / Reload** — run classification once and apply the result  
- **Labels** — list sprite labels for the current character  
- **Reset prompt** — restore the default prompt template  
- **Refresh** — reload labels from the server  

Status line and output box show the last result or error. Visual toasts appear **only on errors**.

---

## Prompt wrappers

Use these inside the extension prompt. They are expanded right before each call.

| Wrapper | Expands to |
|--------|------------|
| `{{labels}}` | Available expression labels, one per line |
| `{{labels_inline}}` | Same labels, comma-separated on one line |
| `{{history}}` | Last N messages (N = History setting) |
| `{{history:N}}` | Last N messages, ignoring the History setting |
| `{{last_char}}` | Last non-user, non-system message text |
| `{{last_user}}` | Last user message text |
| `{{last_message}}` | Very last message in the chat |
| `{{expression}}` | Last successfully classified expression |
| `{{char}}` | Current character name |
| `{{user}}` | Current user name |

Unknown wrappers are left unchanged.

### Default prompt

```
You are an expression classifier for a roleplay character.

Available expressions:
{{labels}}

Conversation (most recent last):
{{history}}

Reply ONLY with ONE expression from the list above. Nothing else.
```

You can replace this entirely. The model must return a single label that exists in `{{labels}}`; anything else is discarded.

---

## Slash commands

| Command | Action |
|--------|--------|
| `/er reload` | Reclassify and apply expression now |
| `/er labels` | Show available labels for the current character |
| `/er current` | Show the last classified expression |

Aliases: `/expression-router`, `/Expression-Router`.

Examples:

```
/er reload
/er labels
/er current
```

---

## How classification works

1. **Trigger** — `MESSAGE_RECEIVED` (after the character message is in chat), or manual Test / `/er reload`  
2. **Labels** — fetched from `/api/sprites/get` for the current character (respects expression folder overrides)  
3. **Prompt** — your template with wrappers expanded  
4. **Call** — direct HTTP request to the provider in the Connection Profile (OpenAI-compatible, Anthropic, Google, etc.)  
5. **Parse** — strips think-blocks and code fences; accepts plain text or `{"expression":"..."}`  
6. **Validate** — exact match, then case-insensitive match against available labels  
7. **Apply** — `sendExpressionCall` with `force: true`, and updates ST’s fallback expression so the built-in worker does not overwrite it  

If the profile is missing, the key cannot be read, or the reply is not a valid label, classification is skipped and an error toast is shown (when the run was manual).

---

## Character changes

On `CHAT_CHANGED` the label cache is cleared and rebuilt for the new character.  
`{{expression}}` is reset. Profile list and label preview in the UI are refreshed.

---

## Notes

- Classification runs only when the extension is **Enabled** and a valid Connection Profile is selected.  
- Keep **Max tokens** small (e.g. 16–32); the expected answer is a single word.  
- Custom (non-default) sprite labels should also be registered in ST’s Expressions extension if you want full compatibility with ST’s own UI.  
- This extension does not upload sprites, manage conditionals, or change backgrounds — it only classifies and applies expressions.
