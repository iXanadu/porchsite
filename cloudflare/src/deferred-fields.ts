/** Request-local collections with explicit copy and provenance-walk semantics. */
type Field = { read: () => unknown; ready: boolean; value?: unknown };
const deferred = new WeakMap<object, Map<string, Field>>();

export function deferFields<T extends Record<string, any>>(view: T, readers: Record<string, () => unknown>): T {
  const fields = deferred.get(view) ?? new Map<string, Field>();
  deferred.set(view, fields);
  for (const [key, read] of Object.entries(readers)) {
    const field: Field = { read, ready: false };
    fields.set(key, field);
    Object.defineProperty(view, key, { enumerable: true, configurable: true, get() {
      if (!field.ready) { field.value = field.read(); field.ready = true; }
      return field.value;
    } });
  }
  return view;
}

/** Transform ordinary fields now, deferred collections only on consumption. */
export function mapFields(source: Record<string, any>, visit: (value: any, key: string) => any): Record<string, any> {
  const fields = deferred.get(source);
  if (!fields) return Object.fromEntries(Object.entries(source).map(([key, value]) => [key, visit(value, key)]));
  const view = Object.fromEntries(Object.keys(source).filter(key => !fields?.has(key)).map(key => [key, visit(source[key], key)]));
  if (fields) deferFields(view, Object.fromEntries([...fields.keys()].map(key => [key, () => visit(source[key], key)])));
  return view;
}

/** View extensions must copy collection recipes rather than spread getters. */
export function extendFields(source: Record<string, any>, extra: Record<string, any>): Record<string, any> {
  return Object.assign(mapFields(source, value => value), extra);
}

/** Embed discovery sees consumed collections without evaluating unused ones. */
export function visitedValues(source: object): unknown[] {
  const fields = deferred.get(source);
  if (!fields) return Object.values(source);
  const values = Object.keys(source).filter(key => !fields?.has(key)).map(key => (source as Record<string, unknown>)[key]);
  if (fields) for (const field of fields.values()) if (field.ready) values.push(field.value);
  return values;
}
