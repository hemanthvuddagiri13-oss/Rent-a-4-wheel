#!/usr/bin/env bash
set -euo pipefail
mkdir -p artifacts
capture() {
  adb logcat -d '*:E' ReactNativeJS:V AndroidRuntime:V > artifacts/android-runtime.txt
  adb exec-out screencap -p > artifacts/android-final.png
}
trap capture EXIT
adb reverse tcp:3000 tcp:3000
adb install apps/customer/android/app/build/outputs/apk/release/app-release.apk
"$HOME/.maestro/bin/maestro" test apps/customer/.maestro/customer.yaml --test-output-dir "$PWD/artifacts/maestro" --format junit --output artifacts/android-results.xml

npx tsx tests/helpers/customer-native-fixture.ts --assert
