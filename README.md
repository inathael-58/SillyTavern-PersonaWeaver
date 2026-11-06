# SillyTavern-PersonaWeaver

The weaver who weaves your high quality persona.

A SillyTavern extension that turns a rough persona into a layered one.

You keep writing personas the way you always do, a few rough lines. Weaver keeps every fact in them and adds the layers that make a persona feel like a person: inner conflict, real voice samples, what each side knows about the other, and rules for how an AI should write your turns.

Works with SillyTavern 1.19 and newer. Uses whatever API you already have connected. No server plugin.

## Install

Extensions → Install extension → paste this repository's URL. Or copy the folder to `public/scripts/extensions/third-party/SillyTavern-PersonaWeaver/` and reload.

Open it from the wand menu next to the chat box, from the Extensions panel, or with `/persona-weaver` (alias `/pweave`).

## What it does

**Weave.** Paste rough notes, press *Weave all layers*. You get six editable layers:

| Layer | What it holds |
|---|---|
| Core | Who they are, what they want now |
| Inner conflict | Contradictions written as pairs (wants X / needs Y, says A / means B) |
| Voice | Rhythm, habits, what they never say |
| Voice samples | Five lines of dialogue: angry, tender, lying, flustered, casual |
| What each knows | Secrets and blind spots between `{{user}}` and `{{char}}` |
| Writing rules | Turn length, point of view, never deciding for `{{char}}`, how to end a turn |

Every layer has its own rewrite button. Text you already wrote in a layer is treated as your intent: kept and sharpened, not replaced. *Undo* steps back through the last ten AI changes.

**Mine from chat.** Reads your own messages in the current chat, measures how you actually write (median length, question and ellipsis habits, quoted speech, `*action*` markup), then builds Voice, Samples and Rules from your real lines. Impersonate then sounds like you.

**Evolve.** After an arc, reads the recent story and proposes the smallest changes the persona needs. You see before and after for each changed layer and accept or skip each one.

**Lorebook split.** Moves backstory episodes and secrets out of the always-on persona into keyword-triggered entries, saves them as a lorebook named `PW - <persona name>` and attaches it to the persona. Saving again updates entries with the same title instead of duplicating them.

## Notes

- The full persona is shown with a live token count and a warning above ~700 tokens.
- The `{{user}}` and `{{char}}` macros are protected while talking to the model. SillyTavern normally swaps them for real names inside raw generations, which would leave names where macros belong.
- **Thai spacing.** Models copy the spacing they see around names, so "ไป {{user}} ที่" tends to spread. With the option on (default), spaces between Thai text and `{{user}}`, `{{char}}` or a character name are removed, both in generated text and again on save. Spaces next to English text are never touched.
- The interface is available in Thai and English. Strings live in `i18n.js`.
- Your work in the window is kept in memory while the page stays open, so closing and reopening does not lose it.
- If the model does not follow the block format, the raw output is shown under the editor so nothing is lost.

## Development

Pure logic is in `core.js`, `prompts.js` and `i18n.js` and has no SillyTavern imports.

```
node --test test/core.test.mjs
```
