# Bounded, local-only Office XML extraction. No macros, links or archive paths are executed.
import sys, zipfile, xml.etree.ElementTree as ET, json, re
path,kind=sys.argv[1:3]
with zipfile.ZipFile(path) as z:
 infos=z.infolist()
 if len(infos)>10000:raise ValueError('too many archive entries')
 def wanted(n):
  if kind=='.docx':return n=='word/document.xml' or n.startswith(('word/header','word/footer','word/footnotes','word/endnotes')) and n.endswith('.xml')
  if kind=='.pptx':return n.startswith('ppt/slides/slide') and n.endswith('.xml')
  return n=='xl/sharedStrings.xml' or n.startswith('xl/worksheets/sheet') and n.endswith('.xml')
 selected=[i for i in infos if wanted(i.filename)]
 if not selected or sum(i.file_size for i in selected)>16*1024*1024:raise ValueError('document XML exceeds limit')
 texts=[];shared=[]
 if kind=='.xlsx' and 'xl/sharedStrings.xml' in z.namelist():
  raw=z.read('xl/sharedStrings.xml')
  if b'<!DOCTYPE' in raw or b'<!ENTITY' in raw:raise ValueError('XML entities disabled')
  shared=[''.join(x.itertext()) for x in ET.fromstring(raw)]
 for info in sorted(selected,key=lambda i:i.filename):
  if info.filename=='xl/sharedStrings.xml':continue
  raw=z.read(info)
  if b'<!DOCTYPE' in raw or b'<!ENTITY' in raw:raise ValueError('XML entities disabled')
  tree=ET.fromstring(raw);lines=[]
  if kind=='.xlsx':
   for row in tree.iter():
    if row.tag.split('}')[-1]!='row':continue
    cells=[]
    for cell in row:
     value=''.join(e.text or '' for e in cell.iter() if e.tag.split('}')[-1] in ['v','t'])
     if cell.attrib.get('t')=='s':value=shared[int(value)] if value.isdigit() and int(value)<len(shared) else value
     cells.append(cell.attrib.get('r','')+': '+value)
    lines.append('\t'.join(cells))
  else:
   for p in tree.iter():
    if p.tag.split('}')[-1]=='p':lines.append(''.join(t.text or '' for t in p.iter() if t.tag.split('}')[-1] in ['t','tab','br']))
  label='' if kind=='.docx' else ('工作表 ' if kind=='.xlsx' else '幻灯片 ')+str(len(texts)+1)+'\n'
  texts.append(label+'\n'.join(lines))
 print(json.dumps({'text':'\n\n'.join(texts)},ensure_ascii=False))
