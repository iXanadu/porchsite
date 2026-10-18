"""Mechanical projection of visitor HTML; no fetching or agent directions."""
import re
from html.parser import HTMLParser
from ada_url import URL

VOID = set('area base br col embed hr img input link meta param source track wbr'.split())
OMIT = set('script style nav form button input select textarea svg canvas iframe object template noscript'.split())


def trim(value):
    return value.strip(' \t\r\n\f')


def inline_text(value):
    return trim(re.sub(r'[ \t\r\n\f]+', ' ', value))


def block_text(value):
    value = re.sub(r'^( {0,3})(#{1,6}(?= |$)|[-+](?= |$)|(?:- *){3,}$|=+ *$)', lambda m: m[1]+'\\'+m[2], value, flags=re.M)
    return re.sub(r'^( {0,3}\d{1,9})([.)])(?= |$)', lambda m: m[1]+'\\'+m[2], value, flags=re.M)


def md_text(value):
    value = re.sub(r'[\\`*_\[\]|]', lambda m: '\\'+m[0], value)
    value = re.sub(r'~{2,}', lambda m: m[0].replace('~', '\\~'), value)
    return block_text(value.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;'))


def hidden(n):
    a = n['attrs']
    return n['tag'] in OMIT or 'hidden' in a or a.get('aria-hidden') == 'true' or bool(re.search(r'(?:^|\s)sk-owner-link(?:\s|$)', a.get('class', ''))) or bool(re.search(r'(?:display\s*:\s*none|visibility\s*:\s*hidden)', a.get('style', ''), re.I))


class Tree(HTMLParser):
    def __init__(self, source):
        super().__init__(convert_charrefs=True)
        self.root = dict(tag='root', attrs={}, children=[], text='')
        self.stack = [self.root]
        self.feed(source)
        self.close()

    def handle_starttag(self, tag, attrs):
        if self.stack[-1]['tag'] in ('script', 'style', 'textarea'):
            return
        values = {}
        for key, value in attrs:
            values.setdefault(key, value or '')
        n = dict(tag=tag, attrs=values, children=[], text='')
        self.stack[-1]['children'].append(n)
        if tag not in VOID:
            self.stack.append(n)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        top = self.stack[-1]['tag']
        if top in ('script', 'style', 'textarea') and tag != top:
            return
        for i in range(len(self.stack)-1, 0, -1):
            if self.stack[i]['tag'] == tag:
                self.stack = self.stack[:i]
                break

    def handle_data(self, data):
        self.stack[-1]['children'].append(dict(tag='', attrs={}, children=[], text=data))


def find(n, tag, visible=True):
    if visible and hidden(n):
        return None
    if n['tag'] == tag:
        return n
    for child in n['children']:
        found = find(child, tag, visible)
        if found is not None:
            return found
    return None


def children(n, render, markdown=False):
    result, previous = '', None
    # Direct text distinguishes mixed prose from an element-only label group.
    group = not any(not c['tag'] and inline_text(c['text']) for c in n['children'])
    for child in n['children']:
        value = render(child)
        if not value:
            continue
        if group and previous is not None and previous['tag'] and child['tag'] and result and result[-1] not in ' \t\r\n\f' and value[0] not in ' \t\r\n\f':
            result += ' '
        if markdown and result.endswith('!') and value.startswith('['):
            result = result[:-1]+'\\!'
        result += value
        previous = child
    return result


def text(n):
    return '' if hidden(n) else n['text'] + children(n, text)


def agent_url(value, base):
    try:
        u = URL(value, base)
        if u.protocol not in ('https:', 'http:', 'mailto:', 'tel:') or u.username or u.password:
            return ''
        return re.sub(r'[<>()]', lambda m: '%'+format(ord(m[0]), '02X'), u.href)
    except ValueError:
        return ''


def table_inline(n):
    return hidden(n) or (n['tag'] not in ('table', 'pre', 'p', 'div', 'ul', 'ol', 'li', 'blockquote', 'section', 'article', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6') and all(table_inline(c) for c in n['children']))


def table_rows(n):
    rows = []
    if sum(c['tag'] == 'caption' and not hidden(c) for c in n['children']) > 1:
        return None
    for child in n['children']:
        if hidden(child):
            continue
        if child['tag'] not in ('tr', 'thead', 'tbody', 'tfoot', 'caption') and (child['tag'] or inline_text(text(child))):
            return None
        if child['tag'] in ('thead', 'tbody', 'tfoot') and any(not hidden(c) and c['tag'] != 'tr' and (c['tag'] or inline_text(text(c))) for c in child['children']):
            return None
        candidates = [child] if child['tag'] == 'tr' else [c for c in child['children'] if c['tag'] == 'tr' and not hidden(c)] if child['tag'] in ('thead', 'tbody', 'tfoot') else []
        for row in candidates:
            if any(not hidden(c) and c['tag'] not in ('th', 'td') and (c['tag'] or inline_text(text(c))) for c in row['children']):
                return None
            cells = [c for c in row['children'] if c['tag'] in ('th', 'td') and not hidden(c)]
            if any(c['attrs'].get('colspan', '1') != '1' or c['attrs'].get('rowspan', '1') != '1' or not all(table_inline(x) for x in c['children']) for c in cells):
                return None
            rows.append(cells)
    if not rows or not rows[0] or len(rows[0]) > 64 or len(rows)*len(rows[0]) > 4096 or any(c['tag'] != 'th' for c in rows[0]) or any(len(r) != len(rows[0]) for r in rows):
        return None
    return rows


def code_span(content, table=False):
    ticks = '`' * max([1] + [len(m[0])+1 for m in re.finditer(r'`+', content)])
    return ticks+content+ticks if table and re.fullmatch(r' +', content) else ticks+' '+content+' '+ticks


def visible_document_text(source):
    """Search uses the same visible document, never markup or hidden URLs."""
    tree = Tree(source).root
    body = find(tree, 'body') or tree
    main = find(body, 'main') or body
    blocks = set('address article aside blockquote br caption dd div dl dt figcaption figure footer h1 h2 h3 h4 h5 h6 header hr li main ol p pre section table td th tr ul'.split())
    def read(n):
        if hidden(n):
            return ''
        if n['tag'] == 'img':
            return inline_text(n['attrs'].get('alt', ''))
        value = n['text']+children(n, read)
        return ' '+value+' ' if n['tag'] in blocks else value
    footer = find(body, 'footer')
    return inline_text(read(main)+(' '+read(footer) if footer and not find(main, 'footer') else ''))


def markdown_document(source, canonical):
    tree = Tree(source).root
    body = find(tree, 'body') or tree
    main = find(body, 'main') or body
    title_node = find(main, 'h1')
    empty = dict(tag='', attrs={}, children=[], text='')
    title = inline_text(text(title_node or find(tree, 'title', False) or empty))
    description = ''

    def meta(n):
        nonlocal description
        if n['tag'] == 'meta' and n['attrs'].get('name', '').lower() == 'description':
            description = inline_text(n['attrs'].get('content', ''))
        for child in n['children']:
            meta(child)
    meta(tree)
    if description and description not in inline_text(text(body)):
        description = ''

    def render(n, depth=0, in_table=False):
        tag, attrs = n['tag'], n['attrs']
        if depth > 128 or hidden(n) or n is title_node:
            return ''
        if not tag:
            return md_text(re.sub(r'[ \t\r\n\f]+', ' ', n['text']))
        def inner():
            return children(n, lambda c: render(c, depth+1, in_table), True)
        if tag == 'head' or (main is body and tag == 'header'):
            return ''
        if tag == 'pre':
            content = re.sub(r'\r\n?', '\n', text(n)).removesuffix('\n')
            ticks = '`' * max([3] + [len(m[0])+1 for m in re.finditer(r'`+', content)])
            code = find(n, 'code')
            lang = re.search(r'(?:^|\s)language-([a-zA-Z0-9_+-]{1,32})(?:\s|$)', code['attrs'].get('class', '') if code else '')
            return '\n\n'+ticks+(lang[1] if lang else '')+'\n'+content+'\n'+ticks+'\n\n'
        if tag == 'code':
            content = text(n)
            return r'\|'.join(code_span(c, True) if c else '' for c in re.sub(r'\r\n?|\n', ' ', content).split('|')) if in_table else code_span(content)
        if tag == 'img':
            url = agent_url(attrs.get('src', ''), canonical)
            if in_table:
                url = url.replace('|', '%7C')
            return '!['+md_text(inline_text(attrs.get('alt', '')))+'](<'+url+'>)' if url else ''
        if tag == 'a':
            label = trim(inner()) or md_text(inline_text(attrs.get('aria-label', '')))
            url = agent_url(attrs.get('href', ''), canonical)
            if in_table:
                url = url.replace('|', '%7C')
            return '['+(label or md_text(url))+'](<'+url+'>)' if url else label
        if tag == 'br':
            return '\n'
        if tag == 'hr':
            return '\n\n---\n\n'
        if re.fullmatch(r'h[1-6]', tag):
            return '\n\n'+'#'*int(tag[1])+' '+trim(inner())+'\n\n'
        if tag in ('strong', 'b', 'em', 'i'):
            value = inner()
            mark = '**' if tag in ('strong', 'b') else '*'
            return mark+value+mark if value else ''
        if tag == 'blockquote':
            return '\n\n'+'\n'.join('> '+line for line in trim(inner()).split('\n'))+'\n\n'
        if tag in ('ul', 'ol'):
            items = [c for c in n['children'] if c['tag'] == 'li' and not hidden(c)]
            return '\n\n'+'\n'.join((str(i+1)+'.' if tag == 'ol' else '-')+' '+trim(render(c, depth+1, in_table)).replace('\n', '\n  ') for i, c in enumerate(items))+'\n\n'
        if tag == 'table':
            rows = table_rows(n)
            if rows:
                def cell(c):
                    return trim(re.sub(r'[\r\n\f]+', ' ', children(c, lambda x: render(x, depth+2, True), True)))
                def row(cells):
                    return '| '+' | '.join(cell(c) for c in cells)+' |'
                rules = [{'left': ':---', 'center': ':---:', 'right': '---:'}.get(c['attrs'].get('align'), '---') for c in rows[0]]
                caption = next((c for c in n['children'] if c['tag'] == 'caption' and not hidden(c)), None)
                return '\n\n'+(trim(render(caption, depth+1))+'\n\n' if caption else '')+row(rows[0])+'\n| '+' | '.join(rules)+' |'+''.join('\n'+row(r) for r in rows[1:])+'\n\n'
        value = inner()
        if tag in ('p', 'div', 'dl', 'dt', 'dd', 'section', 'article', 'aside', 'figure', 'figcaption', 'header', 'footer', 'summary', 'tr'):
            return '\n\n'+(block_text(trim(value)) if tag == 'p' else trim(value))+'\n\n'
        return value+' | ' if tag in ('td', 'th') else value

    footer = find(body, 'footer')
    extra = render(footer) if footer and not find(main, 'footer') else ''
    prefix = md_text(description)+'\n\n' if description and description not in inline_text(text(main)) else ''
    content = re.sub(r'\n{3,}', '\n\n', re.sub(r'[ \t]+\n', '\n', trim(prefix+render(main)+extra)))
    return dict(title=title, description=description, markdown=('# '+md_text(title)+'\n\n' if title else '')+'<'+agent_url(canonical, canonical)+'>\n\n'+content+'\n')
