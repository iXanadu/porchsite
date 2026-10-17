"""Fixed Unicode 15.1 normalization/search casing, independent of runtime ICU."""
import json
from importlib.resources import files
_DATA = json.loads(files(__package__).joinpath('read-unicode.json').read_text())
_CLASSES = {int(k): v for k, v in _DATA['classes'].items()}
_DECOMP = {int(k): v for k, v in _DATA['decomp'].items()}
_LOWER = {int(k): v for k, v in _DATA['lower'].items()}

def _expand(n, out):
    h = n - 0xac00
    if 0 <= h < 11172:
        out.extend((0x1100+h//588, 0x1161+(h%588)//28))
        if h%28:
            out.append(0x11a7+h%28)
    elif n in _DECOMP:
        for c in _DECOMP[n]:
            _expand(c, out)
    else:
        out.append(n)

def _pair(a, b):
    if 0x1100 <= a < 0x1113 and 0x1161 <= b < 0x1176:
        return 0xac00+(a-0x1100)*588+(b-0x1161)*28
    if 0xac00 <= a < 0xd7a4 and (a-0xac00)%28 == 0 and 0x11a7 < b < 0x11c3:
        return a+b-0x11a7
    return _DATA['compose'].get(f'{a},{b}')

def read_nfc(value):
    raw = []
    for c in value:
        _expand(ord(c), raw)
    ordered, marks = [], []
    def flush():
        ordered.extend(sorted(marks, key=lambda n: _CLASSES.get(n, 0)))
        marks.clear()
    for n in raw:
        if not _CLASSES.get(n, 0):
            flush()
            ordered.append(n)
        else:
            marks.append(n)
    flush()
    out, starter, last = [], -1, 0
    for n in ordered:
        cls = _CLASSES.get(n, 0)
        joined = _pair(out[starter], n) if starter >= 0 else None
        if joined is not None and (last == 0 or last < cls):
            out[starter] = joined
        else:
            if not cls:
                starter = len(out)
            out.append(n)
            last = cls
    return ''.join(map(chr, out))

_CASED = set(_DATA['cased'])
_IGNORABLE = set(_DATA['ignorable'])

def read_normalize(value):
    """Unicode default lowercase, including contextual Final_Sigma."""
    chars = list(read_nfc(value))
    codes = list(map(ord, chars))
    out = []
    for i, c in enumerate(chars):
        if codes[i] == 0x3a3:
            left, right = i-1, i+1
            while left >= 0 and codes[left] in _IGNORABLE:
                left -= 1
            while right < len(codes) and codes[right] in _IGNORABLE:
                right += 1
            if left >= 0 and codes[left] in _CASED and (right == len(codes) or codes[right] not in _CASED):
                out.append('ς')
                continue
        out.append(_LOWER.get(codes[i], c))
    return ''.join(out)
