/** Complete SQLite migration statements; never split inside trigger bodies. */
export function statements(sql) {
  const result = []; let current = '', words = [], trigger = false, body = 0, cases = 0;
  for (let i = 0; i < sql.length;) {
    let value, word = false; const start = i;
    if (/\s/.test(sql[i])) { while (i < sql.length && /\s/.test(sql[i])) i++; value = ' '; }
    else if (sql.startsWith('--', i)) { const end = sql.indexOf('\n', i + 2); i = end < 0 ? sql.length : end + 1; value = ' '; }
    else if (sql.startsWith('/*', i)) {
      let depth = 1; i += 2;
      while (i < sql.length && depth) {
        if (sql.startsWith('/*', i)) { depth++; i += 2; }
        else if (sql.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      if (depth) throw Error('unterminated SQL comment'); value = ' ';
    } else if ("'\"`[".includes(sql[i])) {
      const close = sql[i] === '[' ? ']' : sql[i]; i++;
      while (true) {
        if (i >= sql.length) throw Error('unterminated SQL quote');
        if (sql[i++] === close) { if (sql[i] === close) i++; else break; }
      }
      value = sql.slice(start, i);
    } else {
      const match = /^(?:[A-Za-z_][A-Za-z_0-9$]*|[0-9]+)/.exec(sql.slice(i));
      if (match) { value = match[0]; i += value.length; word = true; }
      else value = sql[i++];
    }
    if (word) {
      const upper = value.toUpperCase(); words.push(upper);
      if (words.length <= 4) { const prefix = words.filter(x => !['TEMP','TEMPORARY'].includes(x)); trigger = prefix[0] === 'CREATE' && prefix[1] === 'TRIGGER'; }
      if (trigger) {
        if (upper === 'BEGIN') body++;
        else if (body && upper === 'CASE') cases++;
        else if (body && upper === 'END') { if (cases) cases--; else body--; }
      }
    }
    if (value === ';' && sql[start] === ';' && !body) {
      if (current.trim()) result.push(current.trim()); current = ''; words = []; trigger = false;
    } else if (value !== ' ' || !current.endsWith(' ')) current += value;
  }
  if (body || cases) throw Error('unterminated SQL trigger body');
  if (current.trim()) result.push(current.trim());
  return result;
}
