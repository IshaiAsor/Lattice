#!/usr/bin/env bash
#
# Firmware size gate (F3.17). Measures each env's firmware.bin against the app-partition slot it
# will be flashed into, and fails on a genuine overflow.
#
#   ./tools/check-firmware-size.sh                     # every env in [platformio] default_envs
#   ./tools/check-firmware-size.sh multi_socket_8ch-prod esp32s3_mini-test
#
# Why an image that does not fit is worse than a build error: an OTA writes the whole binary into
# the inactive slot, so an oversized image is only discovered on the device, after it has already
# committed to updating — it breaks the very path a fix would have to travel through.
#
# The slot size is taken from PlatformIO's own "Flash: ... from N bytes" line rather than a
# constant in this script. That number is what PlatformIO enforces at link time and it is derived
# from the env's partition table, so it stays correct for every board — including the ones that
# declare no `board_build.partitions` and inherit a flash-size-dependent default (the 4D Systems
# boards resolve to 6,553,600, not the 1,310,720 of Arduino's plain default.csv).
#
# We gate on firmware.bin, NOT on the "used X bytes" program size PlatformIO prints. The .bin
# carries the image header and padding and runs a few KB larger — on MULTI_SOCKET_8_CH the gap is
# ~6.5 KB, which is bigger than the headroom that build has left. The .bin is what gets written to
# the slot, so the .bin is what must fit.

set -euo pipefail

cd "$(dirname "$0")/.."

# Percentage of the slot at which we warn but do not fail. A build this close is one small feature
# away from not fitting, and the point of the warning is that it appears on every run rather than
# being discovered by a failing release.
WARN_PCT=95

# Locate the PlatformIO CLI: on PATH in CI, inside the penv on a dev machine.
PIO="${PIO:-}"
if [ -z "$PIO" ]; then
    if command -v pio >/dev/null 2>&1; then
        PIO=pio
    elif [ -x "$HOME/.platformio/penv/Scripts/pio.exe" ]; then
        PIO="$HOME/.platformio/penv/Scripts/pio.exe"
    elif [ -x "$HOME/.platformio/penv/bin/pio" ]; then
        PIO="$HOME/.platformio/penv/bin/pio"
    else
        echo "error: PlatformIO CLI not found — set PIO=/path/to/pio" >&2
        exit 2
    fi
fi

# No arguments → every hardware env declared in platformio.ini, so a new board is covered by this
# gate the moment it is added. Deliberately reads the [env:...] headers rather than default_envs:
# an env someone left out of default_envs still gets flashed to a device, so it still has to fit.
# `native` is the host unit-test env and has no image.
envs=("$@")
if [ ${#envs[@]} -eq 0 ]; then
    # tr -d '\r': platformio.ini is checked out CRLF on Windows dev machines, and a stray CR would
    # turn into an env name PlatformIO cannot find.
    mapfile -t envs < <(sed -n 's/^\[env:\(.*\)\]/\1/p' platformio.ini | tr -d '\r' | grep -v '^native$')
fi

if [ ${#envs[@]} -eq 0 ]; then
    echo "error: no environments to check" >&2
    exit 2
fi

rows=""
failed=0
warned=0

for env in "${envs[@]}"; do
    echo "── building ${env}"
    # A cached env re-links nothing and just reprints its sizes, so callers that have already built
    # (the release matrix) pay seconds rather than a full rebuild.
    if ! out=$("$PIO" run -e "$env" 2>&1); then
        echo "$out"
        echo "::error::${env} failed to build"
        exit 1
    fi

    # "Flash: [====      ]  26.0% (used 1702521 bytes from 6553600 bytes)"
    slot=$(printf '%s\n' "$out" | sed -n 's/.*Flash:.*from \([0-9]\{1,\}\) bytes.*/\1/p' | tail -1)
    prog=$(printf '%s\n' "$out" | sed -n 's/.*Flash:.*used \([0-9]\{1,\}\) bytes.*/\1/p' | tail -1)
    bin=".pio/build/${env}/firmware.bin"

    if [ -z "$slot" ] || [ ! -f "$bin" ]; then
        echo "::error::${env}: could not determine slot size or find ${bin}"
        exit 1
    fi

    size=$(stat -c%s "$bin")
    pct=$(awk -v s="$size" -v t="$slot" 'BEGIN { printf "%.2f", (s * 100) / t }')
    free=$((slot - size))

    status="ok"
    if [ "$size" -gt "$slot" ]; then
        status="OVERFLOW"
        failed=1
        echo "::error::${env}: firmware.bin is ${size} bytes, $((size - slot)) over its ${slot}-byte slot (${pct}%)"
    elif [ "$((size * 100 / slot))" -ge "$WARN_PCT" ]; then
        status="tight"
        warned=1
        echo "::warning::${env}: firmware.bin is ${pct}% of its OTA slot — only ${free} bytes free"
    fi

    printf '  %s: bin %s / slot %s = %s%% (%s bytes free, program %s)\n' \
        "$env" "$size" "$slot" "$pct" "$free" "$prog"
    rows+="| \`${env}\` | ${size} | ${slot} | ${pct}% | ${free} | ${status} |"$'\n'
done

table="| env | firmware.bin | slot | used | free | |"$'\n'"| --- | ---: | ---: | ---: | ---: | --- |"$'\n'"${rows}"

echo
printf '%s' "$table"

# Surface the numbers on the run itself, so the sealed build's margin is visible without opening
# job logs — the whole reason F3.17 exists is that nobody was watching it.
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
        echo "### Firmware size"
        echo
        printf '%s' "$table"
    } >>"$GITHUB_STEP_SUMMARY"
fi

if [ "$failed" -ne 0 ]; then
    echo "FAIL: at least one image does not fit its OTA slot"
    exit 1
fi
if [ "$warned" -ne 0 ]; then
    echo "PASS (with warnings): every image fits, but at least one is >=${WARN_PCT}% of its slot"
fi
exit 0
