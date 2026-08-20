# Sennheiser direct control — protocol cheat sheet (no WSM)

Reverse-probed 2026-08-20 against the real rig. Two protocols cover everything.

## The rig

| IP (10.10.10.x) | Device | Protocol | Channels seen |
|---|---|---|---|
| .70 | EW-DX EM2, fw 1.2.13 | SSC / UDP 45 | MC1 650.425, MC2 658.275 |
| .71 | EW-DX EM2, fw 3.0.0 | SSC / UDP 45 | MC3 660.450, MC4 668.300 |
| .72 | EW-DX EM2, fw 3.0.3 | SSC / UDP 45 | VOX 1 651.950, VOX 2 668.750 |
| .73 | ew300 G3 (was OFF during probe) | 53212 | — |
| .74–.76 | ew300 G3 receivers | 53212 | VOX 4–6 |
| .77 | ew300 G3 receiver | 53212 | SPARE 606.000 |
| .78–.83 | IEM G4 SR300 | 53212 | VOX 1–6, all stereo |

## EW-DX — SSC (Sound Control), JSON over UDP 45

- Discovery: mDNS `_ssc._udp.local.` (`dns-sd -B _ssc._udp local`).
- One JSON object per datagram, terminate with `\r\n`. Query = send the tree
  with `null` leaves; device fills them in. Errors come back inline with HTTP-ish
  codes (404 not found, 424 failed dependency = linked tx is off, 406, 454).
- Any source port. Poll statics; **meters are subscribe-only**.

```bash
# identity / channels
printf '%s\r\n' '{"device":{"identity":{"product":null,"serial":null,"version":null},"name":null}}' | nc -u -w 2 10.10.10.70 45
printf '%s\r\n' '{"rx1":{"name":null,"frequency":null,"mute":null,"gain":null}}' | nc -u -w 2 10.10.10.70 45
# linked transmitter battery (424 while the mic is off)
printf '%s\r\n' '{"mates":{"tx1":{"battery":{"gauge":null,"lifetime":null,"type":null}}}}' | nc -u -w 2 10.10.10.70 45
# live meters: rssi dBm, rsqi %, divi (active antenna), af dB - streams for lifetime secs
printf '%s\r\n' '{"osc":{"state":{"subscribe":[{"#":{"lifetime":5},"m":{"rx1":{"rssi":null,"rsqi":null,"divi":null,"af":null}}}]}}}' | nc -u -w 6 10.10.10.70 45
# schema introspection - walk the whole tree
printf '%s\r\n' '{"osc":{"schema":[{"rx1":null}]}}' | nc -u -w 2 10.10.10.70 45
```

Top-level schema: `rx1 rx2 device interface osc audio1 m mates rf_scan`.
`rx1`: identification, channel_sorting, presets, sync_settings, warnings, name,
mute, mates, gain, frequency, audio, restore. `mates/tx1`: battery{type,lifetime,gauge},
warnings, version, type, trim, name, mute, lowcut, lock, led, capsule…
`m/rx1`: rssi, rsqi, divi, af. There's also `rf_scan` (!).

## ew G3/G4 (receivers + IEM) — ASCII over UDP 53212

- **Replies only when the source port is also 53212** — bind it (this is why
  probes from an ephemeral port get dead silence; WSM binds 53212).
- Commands end `\r`, one per datagram. Bare word = query. `1000: Invalid
  command [ X ]` reveals the per-family command set.
- `Push <timeout_s> <cycle_ms> 1` subscribes: streams `RF1/RF2` (antenna),
  `RF`, `AF`, `Bat` (`?` when tx off), `States`, `Msg` (`OK`/`RF_Mute`), `Config`.

```bash
# G3 receiver (EM300): Name, Frequency (kHz), Squelch, AfOut, Equalizer, Mute
{ printf 'Name\r'; sleep 0.2; printf 'Frequency\r'; sleep 0.2; printf 'Push 3 300 1\r'; sleep 3; } \
  | nc -u -p 53212 -w 2 10.10.10.74 53212 | tr '\r' '\n'
# IEM G4 (SR300): Name, Frequency, Sensitivity, Mode (1=stereo), Equalizer, Mute
```

Valid on G3 RX: Name Frequency Squelch AfOut Equalizer Mute FirmwareRevision (not: Sensitivity Mode Config Firmware Version).
Valid on IEM: Name Frequency Sensitivity Mode Equalizer Mute FirmwareRevision (not: Squelch AfOut Config Firmware Version).
FirmwareRevision replies e.g. `FirmwareRevision 1.8.0` (G3 RX) / `1.2.0` (IEM G4).
Frequency reply: `Frequency 639100 21 1` — kHz, then bank/channel-ish extras (unconfirmed).

## Gotchas on this Mac

macOS Local Network TCC blocks node/python in Claude's process tree (python:
EHOSTUNREACH; node: silent blackhole). Apple-signed `nc`/`dns-sd`/`ping`/`ssh`
are exempt — hence bash+nc here. `sennheiser-probe.mjs` is the same logic in
node for running on the Pi.

## Next steps if we build this into the controller

- Node service on the Pi: one 53212 socket (shared, demuxed by peer IP) with
  rolling `Push` re-subscribes + one SSC socket per EW-DX with meter
  subscription renewals; expose `/api/mics` + WS, render battery/RF/AF tiles
  in the UI (wire log already has the plumbing for a `senn` proto tag).

## Legacy ew G3 binary protocol (firmware < ~1.7) — UDP 8133

The EM300G3 at .73 (fw 1.4.4) does NOT speak the 53212 ASCII protocol at all —
it predates the "better UDP networking" of fw 1.7. It uses an older binary
protocol on **UDP 8133**, reverse-engineered from a WSM packet capture
(`scratch/captures/g3legacy-8133.txt`, decoded via tcpdump).

- **Subscribe** (controller → device, 18 bytes): `4f1ff1ca` + `<reqIP 4B>` +
  `<reqIP 4B>` + `010001010101`. The device then streams to `<reqIP>:8133`
  (fixed port, taken from the payload — NOT the packet source port). Re-send
  periodically to keep the stream alive.
- **Telemetry** (device → controller, 40 bytes): `[0-2 type][3]=0xca magic`
  `[4]=00 [5-10]=MAC [11]=01 … [15] status … [27-39] RF/AF state`. byte[2]=0xf7.
  Meter byte mapping (from a mic-ON capture, scratch/captures/
  g3legacy-micon-calibration.json, 406 telemetry frames talk/silent/talk):
  byte[19] = RF level (never 0 while TX on; negatively correlated with audio),
  bytes[24]/[22] = AF level (hit 0 in silence, +0.58 correlated),
  byte[17] = AF peak-hold, byte[16] = antenna A/B (1/2). All scaled /255.
  BATTERY: not yet pinned - it doesn't vary in a 40s capture so there's no
  ground truth; leading candidate byte[12] (0 when TX off -> stable 4 when on).
  Frequency is NOT in the frame. See todo.md for the office capture to finish.
- **Identity beacon** (device → controller, 85 bytes, ASCII): e.g.
  `Model=EM300G3   ID=001B667A8EDB   IPA=10.10.10.73`. We parse Model/ID/IPA.
- **Verified** against the real .73: subscribing from a fresh IP (10.10.10.200
  alias) made the device stream 40-byte frames — the replayed token is accepted.
  NB: an IP that WSM recently used sits in a cooldown and won't re-subscribe for
  a while; use a never-before-seen controller IP (the Pi is fine).
- **Port 8133 is single-owner per host**: don't run WSM on the same machine as
  this service (both bind 8133). WSM elsewhere on the LAN is fine.
- config: `{"ip":"10.10.10.73","type":"g3legacy","label":"..."}`. If the
  subscribe yields nothing (e.g. token differs on another firmware), the unit
  falls back to the ICMP present-but-mute card.
