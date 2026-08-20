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

### 2. Frequency (definitely in the protocol — WSM reads AND changes it)
- WSM displays the frequency and can retune the receiver, so both a read and a
  set command exist. It is **not** in the frames we've captured so far: in the
  capture we have, .73 only ever emitted 40-byte telemetry (`f7`) and 85-byte
  identity (`Model=/ID=/IPA=`) frames, and **WSM sent nothing to .73** — i.e. we
  never captured WSM's config read/write exchange. Our `4f1ff1ca` subscribe only
  elicits the telemetry stream, not config.
- **Capture needed:** record ALL traffic to/from .73 (both directions, all
  ports) while doing two things in WSM, with WSM as the only controller:
  1. **Open/select .73** in WSM — this triggers the config *read*; look for a new
     request WSM sends to .73 and the reply carrying the frequency.
  2. **Change the frequency** in WSM to a known new value — this reveals the
     *set* command and confirms the frequency field + its encoding (kHz? channel
     index? note the before/after values so we can locate the bytes).
  ```
  # WSM running, capture both directions on all ports:
  sudo tcpdump -i en0 -nn -s0 -w /tmp/freq73.pcap -G 60 -W 1 host 10.10.10.73
  # then in WSM: open .73, note the freq; change it to a known value; note it.
  ```
  Then decode the read field into `parseLegacyFrame`/a config poll, and (bonus)
  add a set-frequency command.
- **Quick interim fix (no capture):** add `"frequency": <kHz>` (and optionally
  `"name": "<label>"`) to the .73 entry in `config.json` — the monitor already
  honours `cfgFreq`/`cfgName`, so the card shows it like the others until the
  live read is decoded.

### 3. Antenna A/B
- Currently decoded from byte[16] (values 1/2) — **verify** this is really the
  diversity antenna at the office (wiggle antennas / walk around and watch it).

### Nice-to-have
- Full auto-detection: let a `type: "g3"` device try both the 53212 ASCII and the
  legacy 8133 subscribe, and use whichever answers — then `.73` needn't be typed
  `g3legacy` in config at all. (Today the type is set explicitly; it's not shown
  to the user.)
