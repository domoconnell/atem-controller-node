# companion-module-stageit

A [Bitfocus Companion](https://bitfocus.io/companion) module for **Stage It Live** —
runsheet, mic cues and surface drawers as native actions/feedbacks/variables/presets.

It needs nothing created by hand: variables are declared by the module, and
actions/feedbacks get their dropdowns (mics, displays) live from Stage It over
its HTTP API (`/api/companion/*`).

## Install (developer module)
1. `cd companion && npm install`
2. In Companion: **Settings → Developer modules path** → point it at this folder
   (the one containing `companion/manifest.json`), then restart Companion.
3. Add a connection: **Stage It → Stage It Live**, and set the Stage It IP + web port.

To distribute it properly later, build with `@companion-module/tools`
(`companion-module-build`) and submit to the Companion module registry.

See `companion/HELP.md` for the actions, feedbacks, presets and variables.
