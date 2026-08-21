#!/bin/zsh
# Capture the Stage It Live app talking to .73 (WSM closed, app running from
# Terminal). Shows whether .73 returns the c8fcf7ca config block to the app.
OUT=${1:-/tmp/app73.pcap}
IFACE=$(route -n get 10.10.10.73 2>/dev/null | awk '/interface:/{print $2}'); IFACE=${IFACE:-en0}
echo "Capturing app <-> 10.10.10.73 on $IFACE for 40s -> $OUT"
echo "(leave the app running; WSM must be CLOSED so the app is the only controller)"
sudo tcpdump -i "$IFACE" -s0 -U -w "$OUT" -G 40 -W 1 host 10.10.10.73
echo "Done -> $OUT. Tell Claude it's ready."
