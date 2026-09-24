"""Publish only allowlisted synthetic, non-evidence native screenshots."""
import hashlib
import html
import json
import os
from pathlib import Path
import shutil
import subprocess
import struct

ALLOW = {'native-cancellation-recovered', 'native-home', 'native-availability', 'native-price', 'native-trips', 'native-payment-status', 'native-message', 'native-notices', 'native-case', 'host-welcome', 'host-dashboard', 'host-listing', 'host-calendar', 'host-reservations', 'host-pickup', 'host-message', 'host-blocked-keys', 'host-reply-interrupted', 'host-reply-recovered', 'host-return-complete', 'host-incident', 'host-earnings'}

def main():
    if os.environ.get('CI') != 'true' or os.environ.get('APP_ENV') != 'test':
        raise RuntimeError('Synthetic CI gallery only')
    root = Path('artifacts')
    output = root / 'sanitized-gallery'
    output.mkdir(parents=True, exist_ok=True)
    manifest = []
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    for path in sorted(root.rglob('*.png')):
        if output in path.parents or path.stem not in ALLOW or 'takeScreenshot' not in path.parts:
            continue
        name = path.stem + '-' + hashlib.sha256(str(path).encode()).hexdigest()[:8] + '.png'
        shutil.copyfile(path, output / name)
        with path.open('rb') as image:
            header = image.read(24)
        if header[:8] != b'\x89PNG\r\n\x1a\n':
            raise ValueError('Invalid screenshot PNG')
        width, height = struct.unpack('>II', header[16:24])
        manifest.append({'file': name, 'scenario': path.stem, 'source': str(path), 'commit': commit, 'platform': 'iOS simulator' if os.environ.get('RUNNER_OS') == 'macOS' else 'Android emulator', 'role': 'host owner' if path.stem.startswith('host-') else 'customer', 'pixelWidth': width, 'pixelHeight': height, 'evidence': 'installed simulator/emulator app; synthetic account'})
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2))
    figures = ''.join('<figure><img loading="lazy" src="' + html.escape(row['file']) + '" alt="' + html.escape(row['scenario']) + '"><figcaption>' + html.escape(row['scenario']) + '</figcaption></figure>' for row in manifest)
    (output / 'index.html').write_text('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Native acceptance gallery</title><style>body{font:16px system-ui;margin:24px;background:#eee}main{display:flex;flex-wrap:wrap;gap:16px}figure{margin:0;width:360px}img{width:100%}</style><h1>Sanitized native acceptance</h1><p>Synthetic simulator/emulator evidence. No physical-device or production claim.</p><a href="manifest.json">Manifest</a><main>' + figures + '</main></html>')
    print('Sanitized gallery: ' + str(len(manifest)) + ' allowlisted screenshots')

if __name__ == '__main__':
    main()
