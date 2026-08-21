# TODO

## Sennheiser .73 (EM300G3, legacy 8133 protocol) — DONE, one confirmation left

The old receiver at 10.10.10.73 (fw 1.4.4) is read over its pre-1.7 binary
protocol (UDP 8133). As of 2026-08-21 the config block and meter frame are fully
decoded from WSM captures and wired into `src/sennheiser.js`, so .73 now presents
like a full G3 in the Mics app — **name, frequency, AF-out, squelch, RF/AF meters
and battery** (see `scratch/SENNHEISER-NOTES.md` for the byte map).

### Still open
1. **Battery scale confirmation.** Battery = meter-frame byte[18] in *bars*,
   read 3 at 3-bar. It's mapped to % with a provisional 5-bar scale
   (`LEG_BATTERY_BARS_MAX` in sennheiser.js → 3 bars = 60%). Waiting on a
   drained-pack capture: byte[18] should read 2 when WSM shows 2 bars. If the
   gauge tops out at 4 (not 5), change `LEG_BATTERY_BARS_MAX` to 4.
2. **Live check in the app.** Verified against captured frames, not yet against
   the live device (WSM was the single controller during decode). To see it
   live: quit WSM, run the service from Terminal.app (macOS Local Network TCC —
   see the [[macos-lan-tcc-block]] memory), and confirm .73's card shows the
   real name/freq/squelch/AF/battery.
3. (Optional) Re-verify the RF-vs-AF meter split on byte[17]/[19] against a
   talk/silent capture — the % display works but the exact split is inherited
   from the older 40-byte note.
