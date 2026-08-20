# atem-controller

A small Node service (living on a Raspberry Pi) that replaces the
Companion + MixEffect gymnastics for SuperSource animation and multi-step
M/E choreography on the church projection setup:

- **ATEM connection** (10.10.10.51) — full state readback, SuperSource box
  control, M/E transitions, USKs.
- **Look recorder** — one button captures the complete state as a named
  "look": SuperSource boxes + art, M/E 2 program/preview, full USK settings
  (type, fill/key sources, luma/pattern/DVE params, masks — all four
  keyers), media player contents, HyperDeck clip and transport. Stored as
  editable JSON in `looks/`.
- **Transition engine** — `/goto/<look>` plans the choreography by diffing
  the live switcher state against the target look: border keys fade out,
  boxes animate, backgrounds hand off seamlessly, blend keys bracket layout
  changes, HyperDeck is only touched when needed.
- **MixEffect-style SuperSource animation** — tweens box
  position/size/crop from the live state at 30fps with easing.
- **HyperDeck** (10.10.10.55) — play/stop/goto over the Ethernet protocol
  with transport feedback; never restarts a clip that's already playing.
- **Companion integration** — OSC commands in, custom variables + OSC
  feedback out.
- **Web UI** (port 3000) — broadcast-console style app shell: pinned
  Program + Preview **scene monitors** that render what's actually on the
  output — direct feeds as full-frame plates, SuperSource as art + boxes,
  USKs as overlays (pattern keys drawn as their shape), every source in a
  stable distinct colour with labels, **source delineators inside every
  SuperSource box** (the whole source frame dashed, the cropped-away part
  hatched, the visible slice solid with a `100×45%` crop readout — so you
  can see exactly which part of ProPresenter/a camera comes through), and
  **mixes rendered in flight**
  (outgoing under incoming at the transition handle) so a fade looks like a
  fade, not a cut. Preview shows the target look with the live layout
  ghosted underneath, a scrolling library of look
  tiles with Take buttons, a detail sheet with every recorded parameter +
  the engine's plan, USK lamps, HyperDeck transport, a transition widget
  in the header with busy lockout, and Record + Settings dialogs. Built
  with Next.js + Tailwind + shadcn/ui, exported to static files.

## Office session runbook (do this in order)

Everything below has been verified against the built-in ATEM simulator;
the office is where it meets the hardware for the first time. The event
can't be rehearsed, so treat this session as the rehearsal.

1. **Deploy.** On the Mac, on the same network as the Pi:
   `npm run deploy` (asks the Pi password once). Pre-flight refuses to
   ship a missing/stale UI build, a non-parsing server, or an engine audit
   with visible cuts. Stop any copy running on the Mac (`Ctrl+C`) — the
   HyperDeck accepts only one controller.
2. **Confirm real hardware, not the sim.** Open `http://10.10.10.33:3000`.
   The ATEM LED must be **green "ATEM"**, not amber "ATEM · SIM", and there
   must be no simulator banner. HyperDeck green. If ATEM is amber, the Pi
   can't reach 10.10.10.51 — fix the network before anything else.
3. **Settings → ProPresenter IP**: set the Pro Mac's LAN IP (the shipped
   config says `127.0.0.1`, which only works if the service runs on the
   Pro Mac itself). ProPres LED should go green; `/api/timers` lists your
   real timers.
4. **Re-record every look** with the current recorder (Record in the
   header). Existing looks predate media-player capture, so MP safety is
   dormant on them until re-recorded. Name them the same so Companion
   buttons keep working. The `dip` grade is a hint while you do this:
   13 current pairs (ProPresenter looks ↔ `worship-zoom-*`) dip through
   black because the `-cen` looks have no full-frame carrier — record the
   display box top-aligned, or plan to route via `-top`, and they go clean.
5. **Audit from the Mac against the new looks**: `rsync -az
   pi@10.10.10.33:atem-controller/looks/ looks/ && npm test`. Fix anything
   red before going on.
6. **Walk `/acceptance`** on the Pi: every pair, Set up → Run → watch the
   real output → Clean / Issue / Skip with a note. Watch specifically for
   the things the sim cannot see: box-animation smoothness, mix timing,
   whether the "invisible" cuts really are, USK settle latency. The **HW
   column** is the hardware-truth check — any `◆ diverged` is a finding:
   copy the detail into the note.
7. **Companion**: repoint the Generic OSC target to `10.10.10.33`; check
   the `atemcn_*` variables update (`/companion/test`), try `/arm/<look>`
   on a button's press and read `atemcn_next_grade`.
8. **Timer layouts**: open `/designer`, point a ProPresenter web object at
   `http://10.10.10.33:3000/r/layout.html?id=<layout>` over a moving
   background, confirm transparency and that the clock ticks on the real
   output (digit styles too).
9. **Collect**: `rsync -az pi@10.10.10.33:atem-controller/data/ data/`
   brings back the acceptance results and any layouts. Send the issues.

If something is badly wrong mid-session: `Ctrl+C` is not available on the
Pi service — use **STOP** in the header (cuts the sequencer after its
current step), or `ssh pi@10.10.10.33 sudo systemctl restart atem-controller`.

## No ATEM? It simulates one

If the real switcher isn't reachable within `atem.simFallbackMs` (4s), the
service runs a **built-in ATEM simulator** (`src/atem-sim.js`) — a drop-in
for the `atem-connection` object with the same state shape and methods,
seeded from your first recorded look. Transitions genuinely execute against
it (auto transitions run over the mix rate, boxes move, keys toggle), so
the UI, plan previews, storyboard, acceptance runner and even OSC/Companion
all work anywhere. It's unmissable: the ATEM LED goes **amber "ATEM · SIM"**
and the page carries a banner. If the real ATEM appears later it takes over
automatically. Disable with `atem.simulate: false`.

## Running

```bash
npm install        # also installs ui/ deps (postinstall)
npm run build      # builds the web UI into public/ (needed once before npm start)
npm start          # the service: ATEM/HyperDeck/OSC + serves public/ on :3000
npm run deploy     # build UI + deploy everything to the Raspberry Pi (see below)
```

Web UI: `http://<host>:3000`.

### Working on the UI

The UI is a Next.js app in `ui/` (App Router, TypeScript, Tailwind 4,
shadcn/ui). It is **statically exported** (`output: 'export'`) into
`public/`, which the express service serves — so on the Pi there is no
Next server, just static files. `public/` is a build artifact (gitignored).

```bash
npm start           # terminal 1: the service on :3000
npm run ui:dev      # terminal 2: Next dev server on :3001 with hot reload
```

The dev page on :3001 talks to the service on :3000 for `/api/*` and the
WebSocket. Components live in `ui/src/components/atem/`; the live state
hook is `ui/src/hooks/use-atem-state.ts`; API calls in `ui/src/lib/api.ts`;
types mirroring the server snapshot in `ui/src/lib/types.ts`. Add shadcn
components with `cd ui && npx shadcn add <name>`.

The previous single-file UI is kept in `ui-legacy/index.html` for reference.

## Configuration (config.json)

| Key | Meaning |
|---|---|
| `atem.ip` | ATEM switcher address (10.10.10.51) |
| `atem.simulate` / `.simFallbackMs` | Run the built-in ATEM simulator when the real one is unreachable (default on, after 4s) |
| `hyperdeck.ip` / `.port` | HyperDeck 3 (10.10.10.55:9993) |
| `supersource.id` | SuperSource number, zero-indexed (`0` = SS1) |
| `supersource.me` | Main M/E, zero-indexed (`1` = M/E 2, the projection M/E) |
| `supersource.ssInput` | ATEM input number of the SuperSource (6000) |
| `supersource.displayBox` | Zero-indexed box carrying the main display feed (`3` = box 4) |
| `osc.listenPort` | Command port Companion sends to (9000) |
| `osc.feedback[]` | Targets for `/status/...` OSC feedback (Companion listen port 9001) |
| `companion.host` / `.port` | Companion's built-in OSC API for custom variables (10.10.10.20:12321) |
| `companion.varPrefix` | Prefix for the pushed variables (`atemcn_`) |
| `web.port` | Web UI / HTTP API port (3000) |
| `propresenter.ip` / `.port` | ProPresenter Mac's REST API for the countdown renderer (blank IP = demo timer) |
| `propresenter.pollMs` | Timer poll interval (500) |
| `animation.fps` | SuperSource animation tick rate (30) |
| `animation.defaultDurationMs` | Box-move duration when no override given (500) |
| `animation.defaultEasing` | Default easing (`easeInOutQuad`) |
| `transition.keyFadeMs` | Border-key (USK) fade speed (150) |
| `transition.mixRateFrames` | If set, pins the M/E mix rate for background fades; `null` = inherit the switcher |
| `transition.videoFps` | Frame rate used to convert seconds → mix-rate frames (50 — set 60 for 59.94/60p) |
| `transition.dipInput` | Neutral input for the dip-through fallback (default black `0`; `null` disables) |
| `wireLog` | Unified device wire log: one line per message to/from ATEM (or sim), HyperDeck, OSC/Companion, ProPresenter — shown live in the UI's Wire log drawer (bottom of the main page) with `→`/`←` direction, colour-tagged protocol, and identical sequential messages clustered into one `[N]` line. Default on; hot-togglable |
| `wireConsole` | Also print the wire log to the console/journal (plain text in journalctl, colours on a TTY, repeats collapsed to `⋮ ×N` per second). Default off — the UI drawer is the primary view. Hot-togglable |

## Workflow: recording looks

1. Set the switcher up exactly how the look should be (SuperSource layout,
   USKs on air, HyperDeck clip).
2. Web UI → **Record** in the header → name it (or OSC
   `/look/capture <name>`).
3. Repeat per look. Names are canonicalised to lowercase-hyphen slugs
   (`Worship Zoom!` → `worship-zoom`) and must be unique — capturing an
   existing name overwrites it (that's what the **Re-rec** button does).

Each look card in the UI shows everything that was recorded: box layout
preview, per-box sources, SS art fill/key, M/E program/preview, per-USK
settings, HyperDeck clip. Look files in `looks/` are plain JSON — hand-edit
and **Reload files** (or `/reload`) any time.

## The transition engine

`/goto/<look>` first checks for a hand-written macro matching
(current look → target). If none exists, the engine plans the choreography
by diffing the **live** switcher state (not an assumed current look, so it
self-corrects drift) against the target look:

- USKs fade via mix transitions, never cut. Keys come off before boxes
  move; keys go on after boxes settle. Pure border-key fades run fast
  (`keyFadeMs`, 150ms); fades involving the SS-fed blend key (USK3) use the
  normal background rate.
- USK3-style blend keys (fill = SuperSource) fade out before the SS layout
  changes and fade back in only after the new layout is set.
- **Keys on air in both looks** are compared setting-by-setting:
  - same key type / sources / pattern style, only numeric pattern params
    differ (size, softness, symmetry, position) → the key stays on air and
    the params are **tweened live** (`animateUskPattern`);
  - different pattern style, key type, fill/cut source, or mask → the key is
    **recycled**: faded off, reconfigured, faded back on.
- Keys coming on fresh have their recorded settings applied while still off
  air, so they fade in already correct.
- A **blend-key swap** (e.g. USK3 off + USK4 on, same layout) is done as one
  crossfade transition (`key3,key4` selection) so the overlay never fully
  disappears.
- Background changes (SS ↔ direct feed) go via preview + auto transition:
  - **Leaving SS**: the box carrying the incoming feed animates to true
    fullscreen (others shrink out), so the mix fades between identical
    pictures; then SS is snapped offline to the target layout.
  - **Entering SS**: the box carrying the outgoing feed is prepped
    fullscreen offline, the mix lands invisibly, then the box animates to
    its recorded position and keys fade in. If no target box carries the
    feed, it's a genuine content change and fades directly.
- Boxes turning on grow from nothing at their target; boxes turning off
  shrink in place, then are disabled with their recorded geometry restored.
- **Media players are never changed while visible.** Each look records
  what every media player shows (still/clip + filename). When a target
  needs an MP change, every live USK that keys or fills from that MP is
  recycled around the change (fade off → switch → fade on); keys coming on
  get the MP switched before their fade-in; and if SS itself shows the MP
  (art or a box), the change happens inside an SS offline window.
- **Box source swaps** (same layout, different source in an enabled box —
  e.g. ProPresenter → worship laptop in box 4) can't be animated: a source
  change is a hard cut inside live SS. If a live box is a *full-frame
  carrier* (fullscreen, top-aligned, no side/top crop — bottom crop is
  fine), the engine opens an **SS offline window**: keys fade off, other
  boxes animate away, an *invisible* cut to the carrier's own feed, a
  proper mix to the new feed, box retargeting/MP changes/art offline, an
  invisible cut back to SS, boxes animate back, keys fade in. Without a
  valid carrier it degrades to a plain in-SS cut and says so in the plan.
  The same window mechanism serves any "must be off air to change" case.
- **Dip-through fallback**: if a change can't happen on air and there is
  no full-frame carrier, the engine fades the whole M/E to a neutral
  source (`transition.dipInput`, default black), does the work offline,
  and fades back — visible, but graceful, never a cut. Set `dipInput` to
  `null` to disable (the engine then degrades to an in-SS cut and says so).
- **Leaving SS to a feed no live box carries** never retargets a box on air:
  the display box goes fullscreen with its current source, an invisible cut
  lands on that feed, then a genuine mix to the target.
- The HyperDeck is only touched when the target's transport differs from
  live (already-playing clips are never restarted).
- The mix rate is switched per fade and restored at the end; the recorded
  "next transition" selection is restored for normal manual operation.

### The simulator: every plan is proven before it runs

`src/simulator.js` is a virtual switcher. It executes a plan against a
model of the ATEM (program, SS boxes with real geometry and occlusion,
USKs, media players, art) and records every moment the *program picture*
changes, classifying each as invisible / fade / animate / **visible cut**.
Because this event can't be rehearsed, this is the primary quality gate:

- `GET /api/plan/<look>` returns the plan **and its grade**; the main UI
  shows a storyboard of the journey (fade USK1 → animate boxes → mix …)
  with a CLEAN / ▲ CUT badge and timing under the monitors when you hover a
  look, and every tile carries a ✓/▲ graded from live state.
- **Three grades**: **clean** (only invisible handoffs, fades, box moves),
  **dip** (no cuts, but the output fades through black — the engine's last
  resort when a change can't be hidden; graceful, yet visible enough that
  you want to know), **cuts** (a visible cut). Green / amber / red across
  the tile badges (`✓` / `◐ dip` / `▲ cut`), the storyboard, the acceptance
  runner and Companion's `atemcn_next_grade` (`clean`/`dip`/`cuts`;
  `/status/nextGrade` 2/1/0).
- `npm test` runs `test/audit-looks.mjs` (every look-pair; fails only on
  visible cuts, lists dips) and `test/adversarial.mjs` (engineered nasty
  combos). Run it after recording new looks or touching the engine.
  Today: **59 clean · 13 dip · 0 cuts** — every dip is a
  ProPresenter-look ↔ `worship-zoom-*` pair (a box-4 source swap from a look
  with no full-frame carrier). A dip is a hint about the *looks*: reach
  the target via a look that has a carrier (e.g. `worship-zoom-top`), or
  record the "cen" looks with box 4 top-aligned, and it becomes clean.
- The simulator has already caught two real defects the code reading
  missed (an on-air box retarget in the leave-SS handoff; a bottom-cropped
  carrier that wasn't truly invisible) — both fixed.

### Hardware-truth verification (every transition, automatically)

The simulator proves the *engine's logic*; it cannot prove the *hardware*
behaves like the model. So `src/verify.js` closes the loop on every run:
before a plan executes, the simulator predicts the end state; ~350ms after
the sequencer finishes, the real switcher state is read back and diffed
field-by-field (program, every box's enable/source/geometry/crop, every
USK's on-air/fill/type/pattern, media players, SS art). Any divergence is
exactly where reality differs from the model — logged (`[verify] ✗`),
shown in the UI (storyboard strip: `last: ● hw ok` / `◆ hw diverged`,
acceptance runner: an HW column and a detail panel per pair, attached to
each acceptance result), pushed to Companion (`atemcn_verify` =
`ok`/`DIVERGED`, `atemcn_verify_detail`) and to OSC (`/status/verify`).
Verified end-to-end: a deliberately injected stray key press mid-transition
was reported as `USK4 onAir: expected false → got true`. **In the office,
a diverged result is a finding to send back — it means the model needs
correcting before the event.** (Results against the built-in ATEM sim are
labelled as such: they check plumbing, not hardware.)

### Acceptance runner (`/acceptance`, in the app switcher)

For the office session: lists every look pair, shows the simulator's
verdict, **1. Set up** puts the switcher on the from-look, **2. Run**
transitions, and you mark Clean / Issue / Skip with a note. Results are
stored in `data/acceptance.json` (deploy-protected) so the session ends
with a defect list, not memories.

While a sequence runs, further `/goto`s are **rejected, never queued** —
the UI disables its buttons and Companion's `atemcn_transitioning`
variable goes `true`. `/stop` bails out after the current step.

Dry-run any plan without executing: **Plan** button in the UI or
`GET /api/plan/<look>` — returns the exact steps the engine would run from
the current live state.

## OSC reference (Companion → port 9000)

| Address | Args | Action |
|---|---|---|
| `/goto/<look>[/<seconds>]` | (none) | Transition to a look. Optional seconds retimes the background fades and box moves of that run (border-key fades stay at `keyFadeMs`) |
| `/goto` | look, [duration ms] | Same, argument form |
| `/look/apply` | name | Snap SuperSource to look |
| `/look/animate` | name, [ms], [easing] | Tween SuperSource to look |
| `/look/capture` | name | Record the live state as a look |
| `/look/delete` | name | Delete a look |
| `/macro/run` | name | Run a hand-written macro |
| `/stop` | | Stop the running sequence/animation |
| `/usk` | keyer 1-4, `0`/`1`/`toggle` | USK on-air on main M/E |
| `/transition/next` | e.g. `"background,key3"`, [style] | Set next transition |
| `/transition/auto` | | Auto transition main M/E |
| `/transition/rate` | frames | Set the M/E mix rate |
| `/hyperdeck/play` | [loop 0/1] | Play |
| `/hyperdeck/stop` | | Stop |
| `/hyperdeck/clip` | clip id | Goto clip |
| `/arm/<look>` (or `/grade/<look>`) | (none) | Nominate the next look: grades it from live state into `atemcn_next_*` |
| `/companion/test` | | Push test values into the Companion variables |
| `/reload` | | Re-read looks/ and macros/ from disk |

All commands are also available over HTTP for testing:
`POST /api/command {"address": "/goto/worship-zoom-top"}` — plus
`GET /api/status` and `GET /api/plan/<look>`.

## Companion setup

1. **Generic: OSC** connection → target the Pi's IP, port **9000**,
   feedback/listen port **9001**. Look buttons use the action
   *Send message without arguments* with paths like
   `/goto/propres-full-imag` or `/goto/worship-zoom-top/2`.
2. Create **custom variables**: `atemcn_active_look`,
   `atemcn_transitioning`, `atemcn_going_to`, `atemcn_coming_from`.
   The service pushes values via Companion's built-in OSC API
   (`companion.host:12321` — enable OSC in Companion settings). Verify the
   pipe with `/companion/test`.
   Additional variables pushed live: `atemcn_program`, `atemcn_preview`
   (input names), `atemcn_mp1`/`atemcn_mp2` (media player contents),
   `atemcn_usk_on` (e.g. `1,2`), `atemcn_atem`/`atemcn_hyperdeck`
   (`true`/`false`), `atemcn_last_error`.

   **"Will the next press be clean?"** — send `/arm/<look>` (e.g. on the
   button's *press* with the take on *release*, or from a page-load
   trigger) and the service grades that transition from the live state:
   `atemcn_next_look`, `atemcn_next_grade` (`clean`/`dip`/`cuts`),
   `atemcn_next_summary` ("3 fades · 1 move · ~2.1s"). It re-grades
   automatically after every transition. Put a red-if-`cuts` feedback on
   the take button and the operator sees trouble before pressing. After
   each transition `atemcn_verify` reports `ok`/`DIVERGED` (hardware vs
   prediction) with `atemcn_verify_detail`.
3. Button feedback via the internal *Variable: check value* feedback:
   green when `$(custom:atemcn_active_look)` equals the button's look;
   dimmed while `$(custom:atemcn_transitioning)` is `true` (presses are
   rejected during a transition).
4. The `/status/...` stream to port 9001 additionally provides:
   `/status/currentLook <name>` · `/status/busy <0|1> <name>` ·
   `/status/animating <0|1>` · `/status/atem <0|1>` ·
   `/status/hyperdeck <0|1>` · `/status/usk/<1-4> <0|1>` ·
   `/status/error <msg>` — usable with the Generic OSC module's
   listen-feedback for USK/connection lamps.

## Countdown renderer (ProPresenter timers)

The service doubles as a **transparent countdown graphics engine** for
ProPresenter. Pro stays the timer authority (create/start/pause/reset
there); this renders it prettier.

- The service polls the Pro7 REST API (`propresenter.ip` / `.port` in
  Settings; enable Preferences → Network on the Pro Mac) and streams timer
  values to renderer pages over SSE, interpolated client-side for smooth
  seconds. With no IP configured a built-in looping **demo** timer runs so
  designs can be built anywhere.
- **The Timer Designer** (linked from the main UI header, `/designer`) is
  the primary tool: ProPresenter's slide editor only takes ONE web object
  per slide, so a design is built as a **layout** — multiple elements
  dragged, resized and layered on a 16:9 canvas with live transparent
  previews. Element types: **timer fragments** (part/format/font/styling),
  **static text**, **rectangles** and **ellipses** (fill, border,
  radius). Everything can be **rotated**, snaps to a 10px grid and to
  centre guides, and gets an **entrance animation** (fade, slides, zoom,
  pop, wibble, bounce, spin, blur, flip, roll — with duration and delay,
  played when the slide fires; Replay in the designer). A **Layers**
  panel with drag-to-reorder controls stacking; Delete removes the
  selected element (Enter confirms). Layouts are stored server-side
  (`data/timer-layouts.json`, deploy-protected) and each has a single URL
  for ProPresenter: `/r/layout.html?id=<layout-id>` — one web object
  renders every element with one shared data feed.
- **`/r/` remains the single-fragment builder** (URL-parameter based, with
  bookmarks in `data/renderer-presets.json`) for quick one-piece uses.
- Each URL renders **one fragment** of one timer, e.g.
  `/r/timer.html?timer=pre-service&part=minutes&format=words&font=Times New Roman`
  or `?part=seconds&pad=2&font=Helvetica&size=40&shadow=1`.
  Parts: `time`, `minutes`, `seconds`, `hours`, `total-seconds`,
  `total-minutes`, `progress-bar`, `progress-ring`. Options: `format`
  (digits/words — words works on every part, `time` reads "four minutes
  thirty-seven seconds"), `padh`/`padm`/`pads` (zero-pad hours/minutes/
  seconds independently; seconds default on), `case`, `font`, `weight`, `italic`,
  `color`, `opacity`, `shadow`, `stroke`, `spacing`, `align`/`valign`,
  `bg`/`bgopacity`/`radius`/`boxpad` (translucent panel behind the text),
  `stopped` (hold/hide/dash), `zero` (text at 0), `overrun`
  (negative/zero/hide).
- **Text auto-fits its bounding box** by default — and the size is
  **stable for the whole countdown**: it fits against a worst-case template
  (widest digits string for the timer's duration, e.g. `88:88`, or the
  widest words string in the part's value range), so `10:00 → 9:59 → 0:07`
  never changes size mid-run. Only a box resize or a genuine state change
  (zero text, overrun sign) re-fits. `fitpad` scales the fill factor
  (default 0.94); `size=<number>` (vh) gives a fixed size instead.
- The builder's **font dropdown** lists fonts detected in the current
  browser, each rendered in its own face; in Chromium browsers a
  "Load ALL system fonts" option uses the Local Font Access API for the
  complete list. Free-typed font names always work — what matters is the
  font existing on the ProPresenter Mac.
- In ProPresenter add a **Web** media object per fragment, paste the URL,
  and use Pro's own tools to position/size/animate each piece over normal
  media-layer backgrounds. Transparency confirmed working (including
  text-shadow, CSS filters, canvas — re-trigger the slide if a fresh web
  object ever renders without effects).
- `/transparency-test` remains available as a diagnostic page.

## Settings

The gear icon in the web UI header opens **Settings** — a form over
`config.json` (hardware IPs, SuperSource/M/E numbers, timing, Companion,
ports). Timing and Companion values apply live; hardware addresses and
ports are marked *restart* and the dialog offers a **Restart now** button
after saving (the service exits and systemd brings it straight back, the
page reloads itself). Same API: `GET /api/config`, `PUT /api/config`,
`POST /api/restart`.

## Hand-written macros (escape hatch — you probably don't need this)

Macros predate the transition engine. Every transition is now planned
automatically by the engine, and there is nothing in `macros/` — the folder
exists purely as an override mechanism: if the engine ever produces the
wrong choreography for one specific (from → to) pair and you'd rather
script it than fix the engine, drop a JSON file in `macros/` and it will win
for that pair (`/reload` after adding). Macros are not shown in the UI.

```json
{
  "name": "special-case",
  "from": "look-a",
  "to": "look-b",
  "steps": [ { "type": "setNextTransition", "selection": ["key1"] }, ... ]
}
```

`from: "*"` (or omitted) matches any current look.

| Step | Fields | Notes |
|---|---|---|
| `setNextTransition` | `selection` (`background`, `key1`..`key4`), `style` (`mix`/`dip`/`wipe`/`dve`/`sting`), `me` | |
| `auto` | `me`, `wait` (default true) | Auto transition; waits for completion |
| `cut` | `me` | |
| `preview` / `program` | `input`, `me` | SuperSource 1 = 6000 |
| `uskOnAir` | `keyer` (0-indexed), `onAir`, `me` | Hard cut a keyer |
| `animate` | `look`, `duration` ms, `easing` | Tween SS to a look's layout |
| `applyLook` | `look` | Snap SS to a look's layout |
| `animateBoxes` | `targets` (array of 4 box prop objects/null), `duration`, `easing` | Tween to explicit values |
| `setBoxes` | `boxes` (`{index: props}`) | Raw box set (offline prep) |
| `setSsProperties` | `props` | SuperSource art settings |
| `mediaPlayerSource` | `player` (0-indexed), `source` `{sourceType, stillIndex, clipIndex}` | Switch a media player (engine only emits it while off air) |
| `uskSettings` | `keyer` (0-indexed), `settings` (a look's `me.usk[n]` record) | Apply type/sources/pattern/mask (diff only) |
| `animateUskPattern` | `keyer`, `pattern` (target values), `duration`, `easing` | Tween pattern params on air |
| `setMixRate` | `frames`, `me` | M/E mix rate |
| `hyperdeckEnsure` | `status` (`play`/`stop`), `clipId`, `loop`, `singleClip` | Idempotent transport control |
| `hyperdeck` | `command`: `play`/`stop`/`gotoClip`/`nextClip`/`prevClip`/`raw` | Unconditional |
| `wait` | `ms` | |
| `waitForTransition` | `me` | Wait out an external transition |
| `setCurrentLook` | `look` | Update tracked look (auto-appended when `to` set) |

Easings: `linear`, `easeInQuad`, `easeOutQuad`, `easeInOutQuad`,
`easeInCubic`, `easeOutCubic`, `easeInOutCubic`, `easeInOutSine`.
`me` is zero-indexed and defaults to `supersource.me`.

## Raspberry Pi deployment

One command from the dev machine (asks for the Pi password once):

```bash
npm run deploy                     # deploys to pi@10.10.10.33
npm run deploy -- pi@<other-ip>    # different target
```

The script (`deploy/deploy.sh`, run via `npm run deploy` which builds the
UI first):

1. opens a multiplexed SSH connection (password typed once, never stored),
2. installs Node 20 via NodeSource if the Pi lacks Node ≥ 18,
3. rsyncs the project (service source + built `public/`, not the `ui/`
   source tree) to `/home/pi/atem-controller` — looks/macros captured
   **on the Pi** are protected from deletion,
4. `npm install --omit=dev`, installs `deploy/atem-controller.service` into
   systemd, enables it (**starts on boot**, auto-restarts on crash within
   3s), restarts it,
5. verifies the web UI answers on port 3000 and reports ATEM connectivity.

Re-run the same command to deploy updates.

Afterwards:

```bash
ssh pi@10.10.10.33 journalctl -u atem-controller -f      # live logs
ssh pi@10.10.10.33 sudo systemctl restart atem-controller
rsync -az pi@10.10.10.33:atem-controller/looks/ looks/   # pull Pi-captured looks back
```

**Run only ONE instance at a time** — the HyperDeck Ethernet protocol
accepts a single controller connection, so stop the dev-machine copy
(Ctrl+C) when the Pi service is running. And give the Pi a DHCP
reservation/static IP: Companion's OSC target points at it.

## Architecture

```
src/index.js      wiring / bootstrap
src/config.js     config.json loader
src/atem.js       atem-connection wrapper (state, transitions, USKs, SS boxes)
src/animator.js   SuperSource tween engine (30fps, easing, cancellable,
                  fire-and-forget frames so network RTT can't throttle it)
src/looks.js      look recorder/store (looks/*.json), slug names, current look
src/engine.js     transition planner: live state → target look → step list
src/sequencer.js  step runner + hand-written macro overrides (macros/*.json)
src/hyperdeck.js  minimal HyperDeck Ethernet protocol client (TCP 9993)
src/osc.js        OSC in (commands) + out (/status feedback, Companion vars)
src/web.js        express + websocket status server (reuses the OSC router)
ui/               Next.js + Tailwind + shadcn UI source (static export → public/)
public/           built UI (generated, gitignored)
ui-legacy/        the old single-file UI, for reference
deploy/           deploy.sh + systemd unit
```

Notes:

- SuperSource box units are raw ATEM protocol values: `x` ±4800, `y` ±2700
  (hundredths of DVE units; the frame is 32×18 units), `size` 0–1000,
  crops in thousandths (left/right 0–32000, top/bottom 0–18000).
- Starting a new animation cancels any running one and takes over from the
  live position.
- On this Mac, macOS Local Network permission blocks LAN access for
  processes spawned by the Claude Code extension — run `npm start` from
  Terminal.app during development. Irrelevant on the Pi.
