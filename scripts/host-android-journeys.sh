#!/usr/bin/env bash
set -euo pipefail
mkdir -p artifacts
capture() {
  adb logcat -d '*:E' ReactNativeJS:V AndroidRuntime:V > artifacts/android-runtime.txt
  adb exec-out screencap -p > artifacts/android-final.png
  node scripts/native-safe-telemetry.mjs
}
trap capture EXIT
adb reverse tcp:3000 tcp:3000
adb install apps/customer/android/app/build/outputs/apk/release/app-release.apk
adb push /tmp/host-native-fixtures/condition.png /sdcard/Download/condition.png
adb push /tmp/host-native-fixtures/interior.png /sdcard/Download/interior.png
adb shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/Download/interior.png
adb shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/Download/condition.png
python3 scripts/host-native-journeys.py android "$HOME/.maestro/bin/maestro"
