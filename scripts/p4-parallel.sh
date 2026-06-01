#!/bin/bash
set -u
DIR="M:/FutureApps/adb-proxy-daemon"
cd "$DIR"
export ADBPD_DB_PATH="$DIR/data/adbpd.db"

bun src/maestro/cli.ts run --device emulator-5554 /tmp/p4-flow-emu.yaml > /tmp/p4-emu.log 2>&1 &
EMU_PID=$!
bun src/maestro/cli.ts run --device R5CN90VPWQW /tmp/p4-flow-usb.yaml > /tmp/p4-usb.log 2>&1 &
USB_PID=$!
echo "EMU_PID=$EMU_PID USB_PID=$USB_PID"
wait $EMU_PID
EMU_RC=$?
wait $USB_PID
USB_RC=$?
echo "EMU exit=$EMU_RC USB exit=$USB_RC"

echo "--- EMU log ---"; tail -25 /tmp/p4-emu.log
echo "--- USB log ---"; tail -25 /tmp/p4-usb.log

echo "--- SQLite ---"
bun -e "import {Database} from 'bun:sqlite'; const db=new Database('$DIR/data/adbpd.db'); for (const r of db.query('SELECT id, serial, host_port, allocated_at, released_at FROM maestro_ports ORDER BY id').all()) console.log(JSON.stringify(r))" 2>&1
