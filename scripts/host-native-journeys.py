"""Installed-app acceptance; expected failures must be the exact detail assertion.

Only disposable synthetic CI uses the fault file. Database assertions run before
any accepted incident screenshot, and every other driver/assertion failure aborts.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import xml.etree.ElementTree as ET


def verify_rejection(report, telemetry, mode):
    root = ET.fromstring(report)
    failures = root.findall('.//failure')
    if len(root.findall('.//testcase')) != 1 or len(failures) != 1 or root.findall('.//error'):
        raise AssertionError('Expected exactly one loaded-detail assertion failure')
    text = ''.join(failures[0].itertext()).strip()
    if text != 'Assertion is false: "Synthetic lost spare key", id: case-detail-title is visible':
        raise AssertionError('Unexpected native failure: ' + text)
    rows = []
    for line in telemetry.splitlines():
        try:
            rows.append(json.loads(line))
        except ValueError:
            pass
    if not any(r.get('event') == 'synthetic.incident_rejected' and r.get('kind') == mode for r in rows):
        raise AssertionError('The intended API failure was not exercised')


def main():
    subprocess.run([sys.executable, 'scripts/test-host-native-journeys.py'], check=True)
    platform, binary = sys.argv[1:3]
    if os.environ.get('CI') != 'true' or os.environ.get('APP_ENV') != 'test':
        raise RuntimeError('Disposable installed-app CI only')
    command = [binary] + (['--device', sys.argv[3]] if platform == 'ios' else [])
    fault = Path('/tmp/host-incident-fault')
    log = Path('/tmp/native-proxy.log')

    def db(flag):
        subprocess.run(['npx', 'tsx', 'tests/helpers/host-native-fixture.ts', flag], check=True, timeout=120)

    def run(flow, label=None, rejection=None):
        label = label or flow
        report = Path(f'artifacts/{platform}-{label}.xml')
        report.unlink(missing_ok=True)
        offset = log.stat().st_size
        result = subprocess.run(command + ['test', f'apps/customer/.maestro/host/{flow}.yaml', '--test-output-dir', str(Path('artifacts', label).resolve()), '--format', 'junit', '--output', str(report)], timeout=1200)
        if rejection:
            if result.returncode == 0:
                raise AssertionError('Failed incident unexpectedly satisfied acceptance')
            with log.open('rb') as stream:
                stream.seek(offset)
                telemetry = stream.read().decode()
            verify_rejection(report.read_text(), telemetry, rejection)
            print(f'Negative installed-app proof: {rejection} rejected by exact loaded-detail assertion.', flush=True)
        else:
            result.check_returncode()

    try:
        fault.unlink(missing_ok=True)
        run('owner')
        fault.write_text('submission')
        run('incident-submit', 'incident-submission-rejected', 'submission')
        db('--assert-no-incident')
        fault.write_text('readback')
        run('incident-submit', 'incident-readback-rejected', 'readback')
        db('--assert-incident')
        fault.unlink()
        run('incident-recover')
        db('--assert-incident')
        # The next flow captures the already-loaded detail only after DB scope/count.
        run('owner-finish')
        run('employee')
        db('--revoke')
        run('revoked')
        db('--assert')
    finally:
        fault.unlink(missing_ok=True)


if __name__ == '__main__':
    main()
