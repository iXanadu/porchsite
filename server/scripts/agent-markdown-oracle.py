"""Independent CommonMark parser for the offline prose oracle; no app imports."""
import json,sys
from markdown_it import MarkdownIt
parser=MarkdownIt('commonmark')
print(json.dumps({key:parser.render(value) for key,value in json.load(sys.stdin).items()}))
