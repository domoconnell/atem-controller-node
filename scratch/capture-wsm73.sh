#!/bin/zsh
# Capture the full WSM <-> .73 (legacy EM300 G3) exchange so we can decode
# frequency / name / squelch / AF-out / battery from the pre-1.7 8133 protocol.
# Runs for 150s then stops on its own (no Ctrl-C timing needed).
#
# Usage:  ./scratch/capture-wsm73.sh
# Then follow the on-screen WSM steps. Analyse afterwards with tcpdump -r.
OUT=${1:-/tmp/wsm73.pcap}
IFACE=$(route -n get 10.10.10.73 2>/dev/null | awk '/interface:/{print $2}')
IFACE=${IFACE:-en0}
echo "Capturing WSM <-> 10.10.10.73 on $IFACE for 150s -> $OUT"
echo "(you'll be asked for your password - tcpdump needs root to sniff)"
echo
echo "While it runs, in WSM, on the .73 (EM300 G3) unit:"
echo "  1. Click it so its detail panel opens (forces WSM to re-read everything)."
echo "  2. NOTE what WSM shows now: Name, Frequency (MHz), Squelch, AF out, Battery %."
echo "  3. Change NAME to  ZZTEST9   (distinctive so it stands out in the bytes)."
echo "  4. Change FREQUENCY to a new legal value - NOTE the old and new MHz."
echo "  5. Change SQUELCH by a few dB - NOTE old and new."
echo "  6. Change AF OUT (output level) by a few dB - NOTE old and new."
echo "  7. (optional) set them all back."
echo "Take your time - it records for 150s. Tell Claude every value you noted."
echo
sudo tcpdump -i "$IFACE" -s0 -U -w "$OUT" -G 150 -W 1 host 10.10.10.73
echo
echo "Done -> $OUT  ($(du -h "$OUT" 2>/dev/null | cut -f1)).  Tell Claude it's ready."
