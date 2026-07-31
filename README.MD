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

If the model returns nothing valid (or the call fails), an optional **fallback expression** is applied instead.

You fully control the prompt. No fixed emotion taxonomy — only the labels that exist as images in the character’s sprite folder.

---

## Requirements

- SillyTavern with the **Expressions (Sprites)** extension enabled  
- At least one **Connection Profile** configured (API source + model)  
- `allowKeysExposure: true` in SillyTavern’s `config.yaml` (needed to read the profile’s API key, same as other sidecar extensions)  
- Character sprites present under the character’s sprite folder  
- An open chat (classification controls stay disabled until a character chat is active)

---

## Settings

| Setting | Description |
|--------|-------------|
| **Enabled** | Turns automatic classification on/off |
| **Connection Profile** | Which saved profile (API + key + model) is used as the sidecar |
| **Fallback expression** | Label applied when classification returns nothing valid or the call fails. Choose **none** to skip |
| **History** | How many recent non-system messages are injected via `{{history}}` |
| **Temperature** | Sampling temperature for the sidecar call (`0` is allowed) |
| **Max tokens** | Max tokens for the sidecar reply (keep low; you only need one label) |
| **Suppress ST classifier** | Sets ST’s built-in expression API to “None” so it does not overwrite this extension’s picks |
| **Prompt** | Full classification prompt (editable). Supports wrappers below |
| **Hide prompt** | Collapses the prompt editor in the UI |
| **Log prompt / Log response** | Writes expanded prompt and raw model reply to the browser console |
| **Header click** | Collapses or expands the whole settings panel |

Buttons (require an open chat):

- **Test / Reload** — run classification once and apply the result  
- **Reset prompt** — restore the default prompt template  
- **Refresh** — reload labels from the server and update the fallback list  

Status line and output box show the last result or error.

**Toasts**

| Source | Success | Error |
|--------|---------|--------|
| Automatic (each message) | silent | console only |
| `/er reload` | silent | toast |
| `/er labels`, `/er current` | pipe / info as needed | toast when relevant |
| UI buttons (Test, Reload, Refresh, …) | toast | toast |

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

You can replace this entirely. The model must return a single label that exists in `{{labels}}`; anything else is discarded (then fallback applies, if set).

---

## Slash commands

| Command | Action |
|--------|--------|
| `/er reload` | Reclassify and apply expression now (silent on success) |
| `/er labels` | Return available labels as a JSON array string |
| `/er current` | Show the last classified expression |

Aliases: `/expression-router`, `/Expression-Router`.

### `/er labels` format

Returns a JSON array string, for example:

```text
["happy","sad","neutral"]
```

Suitable for `/buttons` without extra regex, e.g.:

```
/er labels |
/setvar key=exprs |
/buttons labels={{getvar::exprs}} Choose expression |
/expression-set {{pipe}}
```

---

## Connection profiles

Works with native providers (OpenAI, Claude, Mistral, OpenRouter, Google, xAI, Z.AI, …) and **Custom (OpenAI-compatible)**.

For **Custom**, the Server URL is usually the API base (e.g. `https://host/v1`). The extension appends `/chat/completions` when needed for the direct sidecar request. If you already paste the full path ending in `/chat/completions`, it is left unchanged.

The API key is read from SillyTavern’s secrets store (`api_key_custom` for Custom, provider-specific keys otherwise). `allowKeysExposure` must be enabled.

---

## How classification works

1. **Trigger** — `MESSAGE_RECEIVED` (after the character message is in chat), or manual Test / `/er reload`  
2. **Labels** — fetched from `/api/sprites/get` for the current character (respects expression folder overrides)  
3. **Prompt** — your template with wrappers expanded  
4. **Call** — direct HTTP request to the provider in the Connection Profile  
5. **Parse** — strips think-blocks and code fences; accepts plain text or `{"expression":"..."}`  
6. **Validate** — exact match, then case-insensitive match against available labels  
7. **Apply** — `sendExpressionCall` with `force: true`, and updates ST’s fallback expression so the built-in worker does not overwrite it  
8. **Fallback** — if validation fails or the call errors and a fallback label is configured, that label is applied instead  

---

## Character changes

On `CHAT_CHANGED` the label cache is cleared and rebuilt for the new character.  
`{{expression}}` is reset. Profile list, label preview, fallback options, and control availability are refreshed.

---

## Notes

- Classification runs only when the extension is **Enabled** and a valid Connection Profile is selected.  
- Keep **Max tokens** small (e.g. 16–32); the expected answer is a single word.  
- Custom (non-default) sprite labels should also be registered in ST’s Expressions extension if you want full compatibility with ST’s own UI.  
- This extension does not upload sprites, manage conditionals, or change backgrounds — it only classifies and applies expressions.
