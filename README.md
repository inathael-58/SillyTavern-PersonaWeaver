# SillyTavern-PersonaWeaver

The weaver who weaves your high quality persona.

A SillyTavern extension that turns a rough persona into a layered one.

You keep writing personas the way you always do, a few rough lines. Weaver keeps every fact in them and adds the layers that make a persona feel like a person: inner conflict, real voice samples, what each side knows about the other, and rules for how an AI should write your turns.

Works with SillyTavern 1.19 and newer. No server plugin.

## Install

Extensions → Install extension → paste this repository's URL. Or copy the folder to `public/scripts/extensions/third-party/SillyTavern-PersonaWeaver/` and reload.

Open it from the wand menu next to the chat box, from the Extensions panel, or with `/persona-weaver` (alias `/pweave`).

## API and asking first

Pick the API Weaver uses: SillyTavern's main connection, or any Connection Manager profile (for example a cheap, fast model just for persona work). The choice is in the bar at the top of the window and in the Extensions panel.

**Nothing is sent without asking.** Before every request a dialog shows the task, the API it will go to (you can switch it right there), roughly how many tokens go out and the maximum that can come back, and, on demand, the exact text being sent. *Cancel* sends nothing. There is no silent fallback to another API.

## Persona size

The persona is in the prompt on every turn, so Weaver writes to a budget:

| Size | Budget | Conflicts | Samples | Knows | Rules |
|---|---|---|---|---|---|
| Lean (default) | ~250 tokens | 2 | 3 | 2 | 3 |
| Standard | ~400 tokens | 3 | 4 | 3 | 4 |
| Rich | ~650 tokens | 4 | 5 | 4 | 5 |

The model is told the budget and per-block word limits, asked never to repeat a fact across blocks, and the line counts are cut to size on its output too. The token count at the bottom shows `used / budget`; when it is over, **Condense** (the compress button) rewrites the filled layers down to the budget in one request, keeping the facts. Evolve may replace what is no longer true but must not grow a layer.

## What it does

**Weave.** Paste rough notes, press *Weave all layers*. You get six editable layers:

| Layer | What it holds |
|---|---|
| Core | Who they are, what they want now |
| Inner conflict | Contradictions written as pairs (wants X / needs Y, says A / means B) |
| Voice | Rhythm, habits, what they never say |
| Voice samples | Short lines of dialogue in different moods (angry, tender, deflecting…) |
| What each knows | Secrets and blind spots between `{{user}}` and `{{char}}` |
| Writing rules | Turn length, point of view, never deciding for `{{char}}`, how to end a turn |

Every layer has its own rewrite button. Text you already wrote in a layer is treated as your intent: kept and sharpened, not replaced. *Undo* steps back through the last ten AI changes.

**Mine from chat.** Reads your own messages in the current chat, measures how you actually write (median length, question and ellipsis habits, quoted speech, `*action*` markup), then builds Voice, Samples and Rules from your real lines. Impersonate then sounds like you.

**Evolve.** After an arc, reads the recent story and proposes the smallest changes the persona needs. You see before and after for each changed layer and accept or skip each one.

**Lorebook split.** Moves backstory episodes and secrets out of the always-on persona into keyword-triggered entries, saves them as a lorebook named `PW - <persona name>` and attaches it to the persona. Saving again updates entries with the same title instead of duplicating them.

## Notes

- The full persona is shown with a live token count against the size budget.
- The `{{user}}` and `{{char}}` macros are protected while talking to the model. SillyTavern normally swaps them for real names inside raw generations, which would leave names where macros belong.
- **Thai spacing.** Models copy the spacing they see around names, so "ไป {{user}} ที่" tends to spread. With the option on (default), spaces between Thai text and `{{user}}`, `{{char}}` or a character name are removed, both in generated text and again on save. Spaces next to English text are never touched.
- The interface is available in Thai and English. Strings live in `i18n.js`.
- Your work in the window is kept in memory while the page stays open, so closing and reopening does not lose it.
- If the model does not follow the block format, the raw output is shown under the editor so nothing is lost.

## Updates

Weaver compares the version it is running with the one installed on the server (when the page loads, when you open it, and when the chat changes). Browsers, and iOS home-screen apps especially, often keep running old files after *Update*. If a newer version is installed, a toast and a badge in the window title say so; tap either, or *Load latest version* in the Extensions panel, to fetch every file fresh and reload. An open draft survives the reload.

## Development

Pure logic is in `core.js`, `prompts.js` and `i18n.js` and has no SillyTavern imports. `api.js` sends one request to the chosen API. When you bump the version, change it in both `manifest.json` and `VERSION` in `index.js` (a test checks they match), and add any new file to `FILES` in `index.js`.

```
node --test test/core.test.mjs
```
