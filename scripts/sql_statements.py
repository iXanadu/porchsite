"""Whole SQL statements for compatibility checks, including trigger bodies."""
import re

_DOLLAR = re.compile(r'\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$')
_WORD = re.compile(r'[A-Za-z_][A-Za-z_0-9$]*|[0-9]+')


def lex(sql):
    """Yield lexical units without interpreting quoted content or comments."""
    i = 0
    while i < len(sql):
        start = i
        if sql[i].isspace():
            while i < len(sql) and sql[i].isspace():
                i += 1
            yield 'space', ' '
        elif sql.startswith('--', i):
            end = sql.find('\n', i + 2)
            i = len(sql) if end < 0 else end + 1
            yield 'space', ' '
        elif sql.startswith('/*', i):
            depth = 1
            i += 2
            while i < len(sql) and depth:
                if sql.startswith('/*', i):
                    depth += 1
                    i += 2
                elif sql.startswith('*/', i):
                    depth -= 1
                    i += 2
                else:
                    i += 1
            if depth:
                raise ValueError('unterminated SQL comment')
            yield 'space', ' '
        elif sql[i] in "'\"`[":
            close = ']' if sql[i] == '[' else sql[i]
            i += 1
            while True:
                if i >= len(sql):
                    raise ValueError('unterminated SQL quote')
                if sql[i] == close:
                    i += 1
                    if i < len(sql) and sql[i] == close:
                        i += 1
                    else:
                        break
                elif sql[i] == '\\' and start > 0 and sql[start - 1] in 'Ee' and sql[start] == "'":
                    i += 2
                else:
                    i += 1
            yield 'quoted', sql[start:i]
        elif match := _DOLLAR.match(sql, i):
            delimiter = match.group()
            end = sql.find(delimiter, match.end())
            if end < 0:
                raise ValueError('unterminated SQL dollar quote')
            i = end + len(delimiter)
            yield 'quoted', sql[start:i]
        elif match := _WORD.match(sql, i):
            i = match.end()
            yield 'word', match.group()
        else:
            i += 1
            yield 'symbol', sql[start:i]


def canonical(sql):
    """Exact token comparison: quoted data stays case/whitespace sensitive."""
    return tuple((kind, value.upper() if kind == 'word' else value)
                 for kind, value in lex(sql) if kind != 'space')


def statements(sql):
    out, current, words = [], [], []
    trigger = False
    body = cases = 0
    for kind, value in lex(sql):
        if kind == 'word':
            word = value.upper()
            words.append(word)
            if len(words) <= 4:
                prefix = [x for x in words if x not in ('TEMP', 'TEMPORARY')]
                trigger = prefix[:2] == ['CREATE', 'TRIGGER']
            if trigger:
                if word == 'BEGIN':
                    body += 1
                elif body and word == 'CASE':
                    cases += 1
                elif body and word == 'END':
                    if cases:
                        cases -= 1
                    else:
                        body -= 1
        if value == ';' and kind == 'symbol' and not body:
            text = ''.join(current).strip()
            if text:
                out.append(text)
            current, words, trigger = [], [], False
        elif kind != 'space' or not current or current[-1] != ' ':
            current.append(value)
    if body or cases:
        raise ValueError('unterminated SQL trigger body')
    text = ''.join(current).strip()
    if text:
        out.append(text)
    return out
