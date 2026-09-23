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
for journey in owner employee; do
  "$HOME/.maestro/bin/maestro" test "apps/customer/.maestro/host/$journey.yaml" --test-output-dir "$PWD/artifacts/$journey" --format junit --output "artifacts/android-$journey.xml"
done
npx tsx tests/helpers/host-native-fixture.ts --revoke
"$HOME/.maestro/bin/maestro" test apps/customer/.maestro/host/revoked.yaml --test-output-dir "$PWD/artifacts/revoked" --format junit --output artifacts/android-revoked.xml
npx tsx tests/helpers/host-native-fixture.ts --assert
