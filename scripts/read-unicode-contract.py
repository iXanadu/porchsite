#!/usr/bin/env python3
"""Regenerate the published-read Unicode contract with Python Unicode 15.1."""
import json,unicodedata,pathlib
assert unicodedata.unidata_version=='15.1.0'
decomp={}; classes={}; lower={}; compose={}; cased=[]; ignorable=[]
for n in range(0x110000):
 if 0xD800<=n<=0xDFFF: continue
 c=chr(n); d=unicodedata.decomposition(c)
 is_cased=c.islower() or c.isupper() or c.istitle()
 if is_cased: cased.append(n)
 # Default lowercase Final_Sigma is an oracle for the two derived properties.
 if (('AΣ'+c+' ').lower()[1]=='ς' if is_cased else ('AΣ'+c+'A').lower()[1]=='σ'): ignorable.append(n)
 if d and not d.startswith('<'):
  seq=[int(x,16) for x in d.split()]; decomp[str(n)]=seq
  if len(seq)==2 and unicodedata.normalize('NFC',''.join(map(chr,seq)))==c: compose[f'{seq[0]},{seq[1]}']=n
 if (k:=unicodedata.combining(c)): classes[str(n)]=k
 if c.lower()!=c: lower[str(n)]=c.lower()
p=pathlib.Path(__file__).resolve().parents[1] / 'server/server/app/read-unicode.json'
p.write_text(json.dumps(dict(version='15.1.0',decomp=decomp,classes=classes,compose=compose,lower=lower,cased=cased,ignorable=ignorable),ensure_ascii=True,separators=(',',':'))+'\n')
print(p,p.stat().st_size)
