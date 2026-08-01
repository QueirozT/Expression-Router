# Expression Router

LLM-based sprite expression classifier for SillyTavern.

Uses a **Connection Profile** (API + key already saved in ST) as a sidecar, so classification does not consume the main chat model or its context window.

**Version:** 1.5.0

---

## What it does

After each character message, Expression Router:

1. Builds a prompt with the expressions available for the current character and recent chat history
2. Calls the model from the selected Connection Profile (via ST’s Connection Manager when available, otherwise direct HTTP)
3. Validates that the reply is one of the character’s sprite labels
4. Applies the expression via SillyTavern’s sprite system

If the model returns nothing valid (or the call fails), an optional **fallback expression** is applied instead.

You fully control the prompt. No fixed emotion taxonomy — only the labels that exist as images in the character’s sprite folder.

On chat switch, the last expression saved for that chat is restored when possible (no extra LLM call).

Manual set (`/er set <label>`) uses the **same apply path** as classification and as picking a sprite: `sendExpressionCall` with `force: true`, updates ST’s fallback expression, chat metadata, and `{{expression}}`.

---

## Requirements

- SillyTavern with the Expressions (Sprites) extension enabled and set to [ None ]
- At least one **Connection Profile** configured (API source + model)
- `allowKeysExposure: true` in SillyTavern’s `config.yaml` (needed for the direct-fetch path to read the profile’s API key; same as other sidecar extensions)
- Character sprites present under the character’s sprite folder
- An open chat (classification controls stay disabled until a character chat is active)

---

## Settings

| Setting | Description |
|--------|-------------|
| **Enabled** | Turns automatic classification on/off |
| **Connection Profile** | Which saved profile (API + key + model) is used as the sidecar |
| **Fallback expression** | Label applied when classification returns nothing valid or the call fails. Choose **none** to skip |
| **History** | How many recent non-system messages are injected via `{{history}}` (default: 4, max: 50) |
| **Temperature** | Sampling temperature for the sidecar call (`2` is allowed; default: `0`) |
| **Max tokens** | Cap on the sidecar *reply* length (default: 64). For a single label, 16–32 is usually enough. |
| **Suppress ST classifier** | Disables ST's built-in expression API so it does not override this extension's selections (I recommend manually setting it to [ None ] to avoid silent API usage) |
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

| Source | Success | No valid label / fallback | Error |
|--------|---------|---------------------------|--------|
| Automatic (`MESSAGE_RECEIVED`) | silent | toast (warning) | toast (error) |
| `/er reload` | silent (returns label via pipe) | toast (warning) | toast (error) |
| `/er labels`, `/er current` | pipe / info as needed | — | toast when relevant |
| `/er set <label>` | toast (success) | — | toast (error) |
| UI buttons (Test, Reload, Refresh, …) | toast | toast | toast |

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
| `{{expression}}` | Last successfully classified (or manually set) expression |
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
| `/er reload` | Reclassify and apply expression now (also accepts `classify` / `run`) |
| `/er labels` | Return available labels as a JSON array string (also accepts `list`) |
| `/er current` | Show the last classified / set expression (also accepts `show`) |
| `/er set <label>` | Apply an expression manually without calling the model (also accepts `apply`). Same save path as classification / sprite pick |

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
/er set {{pipe}}
```

### `/er set` examples

```
/er set joy
/er set neutral
/er labels | /er set {{pipe}}
```

The label must exist among the character’s current sprite labels (case-insensitive match).  
Applies via `sendExpressionCall` with `force: true`, updates ST’s `fallback_expression`, chat metadata, and `{{expression}}` — the same path used after automatic classification.

---

## Connection profiles

Works with native providers (OpenAI, Claude, Mistral, OpenRouter, Google, xAI, Z.AI, DeepSeek, Groq, …) and **Custom (OpenAI-compatible)**.

**Call order**

1. **Connection Manager Request Service (CMRS)** — preferred. Server-side, no CORS, uses the selected profile as ST already knows it.
2. **Direct browser fetch** — fallback when CMRS is unavailable or returns empty text. Reads the API key from ST’s secrets store and calls the provider endpoint.

For **Custom**, the Server URL is usually the API base (e.g. `https://host/v1`). On the direct path the extension appends `/chat/completions` when needed. If you already paste the full path ending in `/chat/completions`, it is left unchanged.

The API key is read from SillyTavern’s secrets store (`api_key_custom` for Custom, provider-specific keys otherwise). `allowKeysExposure` must be enabled for the direct path.

Reasoning / thinking tokens are disabled when the provider supports it (`reasoning_effort: none`, `disable_reasoning: true`), with a safe retry if the API rejects those fields.

---

## How classification works

1. **Trigger** — `MESSAGE_RECEIVED` (after the character message is in chat), or manual Test / `/er reload`
2. **Labels** — fetched from `/api/sprites/get` for the current character (respects expression folder overrides)
3. **Prompt** — your template with wrappers expanded
4. **Call** — CMRS first, then direct HTTP to the provider in the Connection Profile
5. **Parse** — strips `<think>` blocks and code fences; accepts plain text or `{"expression":"..."}` / `{"label":"..."}`
6. **Validate** — exact match, then case-insensitive match, then last-line heuristics, then whole-word search in the raw reply (longer labels first)
7. **Apply** — `sendExpressionCall` with `force: true`, updates ST’s `fallback_expression`, stores the expression in chat metadata, and keeps `{{expression}}` in sync
8. **Fallback** — if validation fails or the call errors and a fallback label is configured, that label is applied instead

Manual `/er set <label>` skips steps 3–6 and goes straight to the same **Apply** path.

---

## Character / chat changes

On `CHAT_CHANGED`:

- Label cache is cleared and rebuilt for the new character
- `{{expression}}` is reset
- Profile list, label preview, fallback options, and control availability are refreshed
- If this chat previously had an expression saved in metadata, it is **restored** (no LLM call)
- Otherwise, if a fallback expression is configured, that label is applied once

On `CHARACTER_MESSAGE_RENDERED`, labels are refreshed so newly available sprites are picked up.

---

## Notes

- Classification runs only when the extension is **Enabled** and a Connection Profile is selected. Manual `/er set` only needs an open chat and valid sprite labels.
- Keep **Max tokens** small when the model answers with a single label (16–32 is typical; the default of 64 is already a safe margin). Models that emit long chain-of-thought / reasoning before the answer (e.g. some Cerebras GLM builds) may need **512–1024** so the final label is not cut off.
- Custom (non-default) sprite labels should also be registered in ST’s Expressions extension if you want full compatibility with ST’s own UI.
- This extension does not upload sprites, manage conditionals, or change backgrounds — it only classifies and applies expressions.
- Concurrent classification calls are ignored (`_classifying` guard) so rapid messages do not stack requests.
