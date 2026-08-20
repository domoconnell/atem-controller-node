#!/bin/bash
# Scrapbook: read Sennheiser wireless rig status directly - no WSM needed.
# See scratch/SENNHEISER-NOTES.md for the full protocol cheat sheet.
#
# IMPORTANT (this Mac): node/python are blocked from the LAN by macOS
# "Local Network" TCC on this process tree; Apple-signed binaries (nc,
# ping, dns-sd, ssh) are exempt. Hence bash+nc. The same probes in node
# work fine on the Pi.
#
#  EW-DX EM2 (.70-.72) : SSC - JSON over UDP 45 (any source port)
#  ew300 G3  (.74-.77) : ASCII over UDP 53212, SOURCE PORT MUST BE 53212, \r
#  IEM G4    (.78-.83) : same 53212 protocol, different command set

EWDX="10.10.10.70 10.10.10.71 10.10.10.72"
G3="10.10.10.74 10.10.10.75 10.10.10.76 10.10.10.77"   # .73 currently off
IEM="10.10.10.78 10.10.10.79 10.10.10.80 10.10.10.81 10.10.10.82 10.10.10.83"

ssc() { printf '%s\r\n' "$2" | nc -u -w 2 "$1" 45; }
g34() { # $1 ip, rest = commands sent as separate datagrams from src port 53212
  local ip=$1; shift
  { for c in "$@"; do printf "$c\r"; sleep 0.15; done; sleep 0.6; } \
    | nc -u -p 53212 -w 2 "$ip" 53212 | tr '\r' '\n'
}
val() { grep -m1 "^$2 " <<<"$1" | cut -d' ' -f2-; }
mhz() { awk '{printf "%.3f MHz", $1/1000}' <<<"${1%% *}"; }

echo "══ EW-DX EM2 (SSC, UDP 45) ══"
for ip in $EWDX; do
  id=$(ssc $ip '{"device":{"identity":{"product":null,"version":null},"name":null}}')
  ch=$(ssc $ip '{"rx1":{"name":null,"frequency":null,"mute":null},"rx2":{"name":null,"frequency":null,"mute":null}}')
  bat=$(ssc $ip '{"mates":{"tx1":{"battery":{"gauge":null}},"tx2":{"battery":{"gauge":null}}}}')
  # one meter sample per channel (meters are subscribe-only)
  m=$(printf '%s\r\n' '{"osc":{"state":{"subscribe":[{"#":{"lifetime":1},"m":{"rx1":{"rssi":null,"rsqi":null},"rx2":{"rssi":null,"rsqi":null}}}]}}}' \
      | nc -u -w 2 $ip 45)
  name=$(sed -E 's/.*"name":"([^"]*)".*/\1/' <<<"$id")
  ver=$(sed -E 's/.*"version":"([^"]*)".*/\1/' <<<"$id")
  echo "─ $ip  $name  (EWDX2CH fw $ver)"
  for rx in rx1 rx2; do
    line=$(grep -o "\"$rx\":{[^}]*}" <<<"$ch" | head -1)
    f=$(sed -E 's/.*"frequency":([0-9]+).*/\1/' <<<"$line")
    n=$(sed -E 's/.*"name":"([^"]*)".*/\1/' <<<"$line")
    mu=$(sed -E 's/.*"mute":(true|false).*/\1/' <<<"$line")
    rssi=$(grep -o "\"$rx\":{\"rssi\":[-0-9.]*" <<<"$m" | head -1 | cut -d: -f3)
    rsqi=$(grep -o "\"$rx\":{\"rsqi\":[0-9]*" <<<"$m" | head -1 | cut -d: -f3)
    g=$(grep -o "\"tx${rx#rx}\":{\"battery\":{\"gauge\":[0-9]*" <<<"$bat" | cut -d: -f4)
    echo "    $rx  ${n:-?}  $(mhz ${f:-0})  mute=${mu:-?}  rssi=${rssi:-?}dBm rsqi=${rsqi:-?}%  bat=${g:-n/a (tx off?)}%"
  done
done

echo; echo "══ ew300 G3 receivers (UDP 53212) ══"
for ip in $G3; do
  out=$(g34 $ip Name Frequency Squelch AfOut Mute 'Push 1 300 1')
  [ -z "$out" ] && { echo "─ $ip  (no answer)"; continue; }
  echo "─ $ip  '$(val "$out" Name)'  $(mhz "$(val "$out" Frequency)")  squelch=$(val "$out" Squelch | cut -d' ' -f1)dB af_out=$(val "$out" AfOut | cut -d' ' -f1)dB mute=$(val "$out" Mute)"
  echo "    live: RF1=$(val "$out" RF1)  RF2=$(val "$out" RF2)  AF=$(val "$out" AF)  Bat=$(val "$out" Bat)%  msg=$(val "$out" Msg)"
done

echo; echo "══ IEM G4 transmitters (UDP 53212) ══"
for ip in $IEM; do
  out=$(g34 $ip Name Frequency Sensitivity Mode Mute 'Push 1 300 1')
  [ -z "$out" ] && { echo "─ $ip  (no answer)"; continue; }
  mode=$(val "$out" Mode); [ "$mode" = 1 ] && mode=stereo || mode=mono
  echo "─ $ip  '$(val "$out" Name)'  $(mhz "$(val "$out" Frequency)")  sens=$(val "$out" Sensitivity)dB $mode mute=$(val "$out" Mute)"
  echo "    live: AF=$(val "$out" AF)  States=$(val "$out" States)  msg=$(val "$out" Msg)"
done
