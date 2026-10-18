// Measurement-only binding adapter. SQL and bindings never leave the isolate.
export function observer(database, state) {
  const statements = new WeakMap();
  function note(sql, result) {
    const meta = result?.meta;
    for (const key of ['rows_read', 'rows_written']) {
      if (!Number.isSafeInteger(meta?.[key]) || meta[key] < 0) {
        state.failed = true;
        throw Error('D1 row metadata unavailable');
      }
    }
    if (state.closed) { state.failed = true; throw Error('D1 work outside request scope'); }
    state.rows_read += meta.rows_read;
    state.rows_written += meta.rows_written;
    state.statements++;
    if (/\bpublic_artifacts\b/i.test(sql)) state.artifact++;
    if (/^\s*SELECT\s+l\.\*\s*,\s*i\.created_at\s+FROM\s+live\b/i.test(sql)) state.render++;
    if (/INSERT\s+INTO\s+agent_traffic_daily/i.test(sql)) state.traffic++;
    if (/\bpublic_artifacts\b/i.test(sql) && result.results?.some(row => row.key && row.body)) state.hit++;
  }
  const failed = error => { state.failed = true; throw error; };
  function wrap(statement, sql) {
    const proxy = new Proxy(statement, { get(target, key) {
      if (key === 'bind') return (...args) => wrap(target.bind(...args), sql);
      if (['all', 'run', 'first', 'raw'].includes(key)) return async (...args) => {
        try {
          // first/raw discard metadata in the binding. Execute the identical SQL
          // once through all(), then apply the binding's result projection.
          const result = await target[key === 'first' || key === 'raw' ? 'all' : key](...(['first', 'raw'].includes(key) ? [] : args));
          note(sql, result);
          if (key === 'first') {
            const row = result.results?.[0] ?? null;
            if (row && args[0] !== undefined && !Object.hasOwn(row, args[0])) throw Error('D1 first column unavailable');
            return row && args[0] !== undefined ? row[args[0]] : row;
          }
          if (key === 'raw') {
            const rows = result.results;
            // all() cannot retain a header for an empty relation. Refuse rather
            // than invent raw({columnNames:true}) column identities.
            if (!rows?.length && args[0]?.columnNames) throw Error('D1 raw header unavailable');
            const columns = Object.keys(rows?.[0] ?? {});
            if (columns.some(name => /^(0|[1-9][0-9]*)$/.test(name))) throw Error('D1 raw numeric column unsupported');
            const values = rows.map(row => columns.map(name => row[name]));
            return args[0]?.columnNames ? [columns, ...values] : values;
          }
          return result;
        } catch (error) { return failed(error); }
      };
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    statements.set(proxy, { statement, sql });
    return proxy;
  }
  return new Proxy(database, { get(target, key) {
    if (key === 'prepare') return sql => wrap(target.prepare(sql), sql);
    if (key === 'batch') return async list => {
      try {
        const entries = list.map(value => statements.get(value));
        if (entries.some(value => !value)) throw Error('Unobserved D1 batch statement');
        const results = await target.batch(entries.map(value => value.statement));
        if (results.length !== entries.length) throw Error('D1 batch cardinality changed');
        results.forEach((result, i) => note(entries[i].sql, result));
        return results;
      } catch (error) { return failed(error); }
    };
    if (key === 'exec' || key === 'withSession') return () => failed(Error('Unobserved D1 method'));
    const value = target[key];
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

export function counters() {
  return { rows_read: 0, rows_written: 0, statements: 0, artifact: 0, render: 0, traffic: 0, hit: 0, failed: false, closed: false };
}

export async function settle(pending) {
  let at = 0;
  while (at < pending.length) {
    const batch = pending.slice(at); at = pending.length;
    await Promise.all(batch);
  }
}
