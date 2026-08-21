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

- [ ] **1. HyperDeck instance selector in ATEM Transitions settings.** The
  settings dialog has ATEM + ProPresenter instance pickers but no HyperDeck one.
  Add it (looks capture reads HyperDeck transport). `atemTransitions` setting +
  the legacy hyperdeck should use the selected instance.
- [ ] **2. Top app bar: connection icons for ALL connections.** `app-header.tsx`
  `connGroups()` shows a hardcoded subset (server/atem/hyperdeck/mics/propres).
  Drive it from the engine's instances + `sys:status` so every connector type
  appears, grouped, with per-type online/total + state colour.
- [ ] **3. Pull-out drawers hold ONE full-size widget.** Each of top/bottom/
  left/right drawers should contain a single widget that fills the whole drawer
  (not a grid of small ones). Update `pullouts.tsx` + the add flow.
- [ ] **4. Kill the double widget titles.** Widgets render an internal `Title`
  *and* the placement title — two titles. Default to **no** title; drop the
  internal one and make the placement title opt-in (blank by default).
- [ ] **5. Widget settings sidebar overlap + close.** The designer grid still
  renders under the config sidebar. Fix the layout so it never does, AND add a
  close/✕ on the sidebar that ends the edit session (hide sidebar + deselect the
  widget). The ✕ is the better UX.
- [ ] **6. Connections header/footer widget redesign.** Currently just status
  LEDs + a count. Make it **icon-per-connection**, spread across the strip
  (icon coloured by state), condensing as more are added.
- [ ] **7. Wireless-mic header/footer widget redesign.** Same problem — make it
  icons (per receiver/channel), spread out, not just LEDs.

---

## Big feature: the "Mic" composite object (Features → Mics)

A **Mic** is a first-class internal object that fuses three sources:
- **Sennheiser** receiver/channel → RF level, battery, frequency, name.
- **DiGiCo** channel → mute state, fader.
- **Internal cue state** → LIVE / STANDBY / OFF (driven by the runsheet / manual).

Needs:
- [ ] Data model: `mics` table/store — `{ id, label, sennheiserInstanceId,
  sennheiserChannel, digicoInstanceId, digicoChannel, ... }`.
- [ ] Mapping UI under Settings → Features → Mics: create a mic, pick its
  receiver channel + DiGiCo channel, label it.
- [ ] Composite widget(s): per-mic tile showing label · mic# · internal status ·
  DiGiCo mute · battery% · RF dB. Overview + strip variants.
- [ ] Internal cue state source (LIVE/STANDBY) — set by the runsheet slot that's
  "now"/"next", or manual override.

---

## Big feature: Runsheet / Services app (Dave's, ported + rebuilt)

An **internal** feature (not a connection) — its **own top-level app**.

- [ ] A **Service** = ordered **segments/slots**. Each slot: `{ title, time,
  people[], mics[] }` where people map to Mic objects.
- [ ] Sources: **import from ProPresenter**, **upload CSV**, **manual entry**.
- [ ] "Now / Next" engine: which slot is current vs next (by time or manual
  advance), feeding the Mic internal cue state (LIVE/STANDBY).
- [ ] Widgets:
  - current / next segment + segment timer(s)
  - the **people + mics** widget, e.g.:
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
