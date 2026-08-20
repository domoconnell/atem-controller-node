# TODO

## Sennheiser .73 (EM300G3, legacy 8133 protocol) — finish the decode at the office

The old receiver at 10.10.10.73 is read over its pre-1.7 binary protocol (UDP
8133) and now shows in the Mics app as a normal G3 with live **RF** and **AF**
meters. Three fields still need an in-office capture to finish, because they
either don't vary in a short capture (battery) or aren't in the telemetry frame
(frequency). See `scratch/SENNHEISER-NOTES.md` for the full protocol and
`scratch/captures/g3legacy-micon-calibration.json` for the mic-on capture.

### 1. Battery (highest priority — WSM shows it, so it's in the data)
- The 40-byte telemetry frame is the only stream; battery must be a byte in it.
- It did **not** move during the 40s mic-on capture (battery ~constant over 40s),
  so there's no ground truth to identify the byte from that data.
- **Leading candidate: byte[12]** — it was `0` with the transmitter off and a
  stable `4` with it on (no other stable byte changed like that). Could be a
  0–4/0–5 bar level rather than a %.
- **To confirm & scale:** while capturing, read the battery value WSM shows and
  note it. Ideally capture at two clearly different levels (e.g. a fresh pack and
  a nearly-flat one), so we can see which byte tracks it and what the scale is.
- **Capture procedure** (WSM must be quit — the receiver is single-controller):
  ```
  # on the Mac, mic ON, WSM quit:
  osascript -e 'tell application "Terminal" to do script "/tmp/runcalib2.sh"'
  # (or re-run scratch capture: subscribe to .73:8133 as a fresh IP, log frames)
  ```
  Then in `src/sennheiser.js` set `LEG.battery` to the confirmed offset, decode
  it in `parseLegacyFrame`, and drop the `batteryPending` flag for legacy.

### 2. Frequency
- Not present in the legacy telemetry or the identity beacon (`Model=/ID=/IPA=`).
- **Quick fix (no capture):** add `"frequency": <kHz>` (and optionally
  `"name": "<label>"`) to the .73 entry in `config.json` — the monitor already
  honours `cfgFreq`/`cfgName`, so the card will show it like the others.
- Or capture whether a different 8133 request returns tuning info.

### 3. Antenna A/B
- Currently decoded from byte[16] (values 1/2) — **verify** this is really the
  diversity antenna at the office (wiggle antennas / walk around and watch it).

### Nice-to-have
- Full auto-detection: let a `type: "g3"` device try both the 53212 ASCII and the
  legacy 8133 subscribe, and use whichever answers — then `.73` needn't be typed
  `g3legacy` in config at all. (Today the type is set explicitly; it's not shown
  to the user.)
