"""MD-1 byte comparison; paired with cloudflare/scripts/markdown-parity.ts."""
import json
from pathlib import Path
from server.spec.html import markdown
from server.app.agent_markdown import markdown_document

cases=json.loads((Path(__file__).parents[2]/'spec/markdown-cases.json').read_text())
output=[]
for case in cases:
    html=markdown(case['markdown'])
    output.append(dict(name=case['name'],html=html,markdown=markdown_document('<main><h1>Sample</h1>'+html+'</main>','https://example.com/page/')['markdown']))
print(json.dumps(output,ensure_ascii=False,separators=(',',':')))
