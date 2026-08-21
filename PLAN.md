# Stage It Live — Plan / TODO

Living tracker for the Stage It Live build. Newest batch at the bottom; tick
items as they land. Branch: `stage-it-live`.

## Done (this migration effort)
- Surfaces app (designer + `/surface` viewer): aspects, header/footer strips,
  overlay pull-out drawers, square-filling grid, save feedback, layout persist.
- Purpose-built widget set (4 variants per connector) reading real streams.
- Connector library + engine; legacy stacks (ATEM/HyperDeck/ProPresenter/
  Sennheiser) unified under the engine (`engine.attachLegacy`).
- JSON → SQLite for all state; ATEM Transitions settings live-editable with
  dropdowns from the connected switcher (no restart).
- Sennheiser legacy `.73` fully decoded (name/freq/squelch/AF/battery via WSM
  handshake); battery = byte[12].
- Acceptance relocated under ATEM Transitions (toolbar link).

---

## Batch: fixes + polish (2026-08-21)

- [x] **1. HyperDeck instance selector in ATEM Transitions settings.** The
  settings dialog has ATEM + ProPresenter instance pickers but no HyperDeck one.
  Add it (looks capture reads HyperDeck transport). `atemTransitions` setting +
  the legacy hyperdeck should use the selected instance.
- [x] **2. Top app bar: connection icons for ALL connections.** `app-header.tsx`
  `connGroups()` shows a hardcoded subset (server/atem/hyperdeck/mics/propres).
  Drive it from the engine's instances + `sys:status` so every connector type
  appears, grouped, with per-type online/total + state colour.
- [x] **3. Pull-out drawers hold ONE full-size widget.** Each of top/bottom/
  left/right drawers should contain a single widget that fills the whole drawer
  (not a grid of small ones). Update `pullouts.tsx` + the add flow.
- [x] **4. Kill the double widget titles.** Widgets render an internal `Title`
  *and* the placement title — two titles. Default to **no** title; drop the
  internal one and make the placement title opt-in (blank by default).
- [x] **5. Widget settings sidebar overlap + close.** The designer grid still
  renders under the config sidebar. Fix the layout so it never does, AND add a
  close/✕ on the sidebar that ends the edit session (hide sidebar + deselect the
  widget). The ✕ is the better UX.
- [x] **6. Connections header/footer widget redesign.** Currently just status
  LEDs + a count. Make it **icon-per-connection**, spread across the strip
  (icon coloured by state), condensing as more are added.
- [x] **7. Wireless-mic header/footer widget redesign.** Same problem — make it
  icons (per receiver/channel), spread out, not just LEDs.

---

## Big feature: the "Mic" composite object (Features → Mics)

A **Mic** is a first-class internal object that fuses three sources:
- **Sennheiser** receiver/channel → RF level, battery, frequency, name.
- **DiGiCo** channel → mute state, fader.
- **Internal cue state** → LIVE / STANDBY / OFF (driven by the runsheet / manual).

Needs:
- [x] Data model: `mics` table/store — `{ id, label, sennheiserInstanceId,
  sennheiserChannel, digicoInstanceId, digicoChannel, ... }`.
- [x] Mapping UI — built INTO the Mics app (co-opted per request): "+ Mic"
  → editor (label + Sennheiser receiver + DiGiCo console/channel). Live cards.
- [x] Composite CARDS in the Mics app (reuse the polished meters + battery +
  antenna, add DiGiCo mute + clickable cue chip). Hardware receiver view kept.
- [x] Composite SURFACES widgets: mics-strip (header/footer, spread cells: cue +
  RF/AF + battery + mute) and mics-panel, with a mic multi-select in the add
  flow + config sidebar. New "Mics" widget source (feature widgets).
- [ ] Internal cue state source (LIVE/STANDBY) — set by the runsheet slot that's
  "now"/"next", or manual override.

---

## Big feature: Runsheet / Services app (Dave's, ported + rebuilt)

An **internal** feature (not a connection) — its **own top-level app**.

- [x] A **Service** = ordered **segments**. Each: `{ title, time, people[] }`
  where each person maps to a Mic. Data model + store + `/api/features/services`
  + the **Runsheet app** (new top-level app) with segment/people editing.
- [x] Manual entry.  - [ ] Import from ProPresenter / CSV upload.
- [x] "Now / Next" engine: manual Start/next/prev/stop; the now segment's mics
  go LIVE, the next segment's go STANDBY, the rest OFF (drives mic.cue). Verified.
- [ ] Auto-advance by time / segment timers.
- [x] **Now/Next widget** (runsheet-nownext): NOW + NEXT segment with each
  person + mic status (cue · mute · RF · battery). Auto-follows the running
  service. Matches the sketch:
    ```
    Now: Welcome
      Dan:    Mic 1 · LIVE   · UNMUTED · 99% · -5 dB
      Sheila: Mic 2 · LIVE   · UNMUTED · 94% · -4 dB
    Next: Offering
      Joe:    Mic 3 · STANDBY· MUTED   · 92% · -10 dB
    ```
    (status = internal cue; mute = DiGiCo; battery/RF = Sennheiser)

Data model note: Services reference Mics; Mics reference Sennheiser + DiGiCo
instances. Build the Mic object first, then Services on top.

---

## Deferred (deliberately, with rationale)
- **TypeScript migration of the legacy `src/*.js` stack** (~4400 lines, 17
  files). Native ESM makes it an all-or-nothing sweep; zero user value, real
  regression risk on the live tool. Do as a dedicated pass later, or not at all
  (runs fine under `tsx`).
