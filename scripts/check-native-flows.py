"""Catch missing/cyclic Maestro subflows before expensive native builds."""
from pathlib import Path
import re

root = Path('apps/customer/.maestro').resolve()
seen = set()

def visit(path, stack):
    if path in stack:
        raise RuntimeError('Cyclic Maestro references: ' + ' -> '.join(str(p.relative_to(root)) for p in stack + [path]))
    if path in seen:
        return
    if not path.is_relative_to(root) or not path.is_file():
        raise RuntimeError('Missing or out-of-tree Maestro flow: ' + str(path))
    for reference in re.findall(r'(?:runFlow|file):\s*[\"\x27]?([^\s\"\x27]+\.yaml)', path.read_text()):
        visit((path.parent / reference).resolve(), stack + [path])
    seen.add(path)

for flow in sorted(root.rglob('*.yaml')):
    visit(flow, [])
print('Maestro subflow references validated: ' + str(len(seen)) + ' files, no cycles or missing targets.')
