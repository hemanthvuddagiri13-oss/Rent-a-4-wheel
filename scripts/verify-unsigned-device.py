"""Verify compile artifacts; never certify deployment, signing or installability."""
import hashlib
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import zipfile

platform, target = sys.argv[1:3]
path = Path(target)
mode = os.environ['EXPO_PUBLIC_APP_MODE']
assert mode in ('customer', 'host')
package = 'com.renta4wheel.' + mode + '.trial'
if platform == 'android':
    with zipfile.ZipFile(path) as archive:
        libraries = [n for n in archive.namelist() if n.startswith('lib/') and n.endswith('.so')]
        assert libraries and all(n.split('/')[1] == 'arm64-v8a' for n in libraries), 'Wrong Android ABI'
        config = json.loads(archive.read('assets/app.config'))
    tools = Path(os.environ['ANDROID_BUILD_TOOLS'])
    manifest = subprocess.check_output([str(tools / 'aapt'), 'dump', 'badging', str(path)], text=True)
    assert "package: name='" + package + "'" in manifest
    assert 'application-debuggable' not in manifest
    assert subprocess.run([str(tools / 'apksigner'), 'verify', str(path)], capture_output=True).returncode != 0, 'Unexpected signed build'
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
elif platform == 'ios':
    apps = list(path.glob('Products/Applications/*.app'))
    assert len(apps) == 1
    app = apps[0]
    with (app / 'Info.plist').open('rb') as stream:
        info = plistlib.load(stream)
    assert info['CFBundleIdentifier'] == package
    assert info['CFBundleSupportedPlatforms'] == ['iPhoneOS'], 'Simulator is not a device archive'
    assert not info.get('NSAppTransportSecurity', {}).get('NSAllowsArbitraryLoads', False)
    assert not (app / 'embedded.mobileprovision').exists()
    configs = list(app.glob('**/EXConstants.bundle/app.config'))
    assert len(configs) == 1, 'Missing embedded Expo configuration'
    config = json.loads(configs[0].read_text())
    assert subprocess.run(['codesign', '--verify', str(app)], capture_output=True).returncode != 0, 'Unexpected signed build'
    executable = app / info['CFBundleExecutable']
    arch = subprocess.check_output(['lipo', '-archs', str(executable)], text=True).strip()
    assert arch == 'arm64', 'Wrong iOS device architecture'
    digest = hashlib.sha256(executable.read_bytes()).hexdigest()
else:
    raise ValueError('Unsupported device platform')
assert config['extra'] == {'apiOrigin': os.environ['EXPO_PUBLIC_API_ORIGIN'], 'localAcceptance': False, 'appMode': mode}, 'Unexpected embedded backend or acceptance mode'
assert config['ios']['bundleIdentifier'] == package and config['android']['package'] == package
record = {'commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(), 'platform': platform, 'mode': mode, 'package': package, 'sha256': digest, 'apiOrigin': os.environ['EXPO_PUBLIC_API_ORIGIN'], 'signed': False, 'phoneInstallable': False, 'stagingVerified': False}
output = Path('artifacts')
output.mkdir(exist_ok=True)
(output / ('unsigned-' + platform + '-' + mode + '.json')).write_text(json.dumps(record, indent=2))
print(json.dumps(record))
