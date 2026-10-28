from pathlib import Path
import json,re
root=Path(__file__).resolve().parents[1]
script=root/'web/shared-workbench-ui.js'
text=script.read_text()
prefix,block=text.split('/* BEGIN WAWU VISUAL ALIGNMENT */',1)
css=(root/'web/design-system.css').read_text()
block=re.sub(r'const css = (".*");',lambda _: 'const css = '+json.dumps(css,ensure_ascii=False)+';',block,count=1)
block=re.sub(r'dataset.wawuVisual = "[^"]+"','dataset.wawuVisual = "2026.10.21-unified-workbench-01"',block)
script.write_text(prefix+'/* BEGIN WAWU VISUAL ALIGNMENT */'+block)
print('Shared design system generated for the existing native and web clients.')
