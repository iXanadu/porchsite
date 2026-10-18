/** Request-owned template values; metadata walks never evaluate them. */
const recipes = new WeakMap<object, Record<string, () => unknown>>();
export function lazyValues<T extends Record<string, any>>(view:T, values:Record<string,()=>unknown>):T {
  recipes.set(view,values);
  for(const [key,read] of Object.entries(values)){
    let ready=false,value:unknown;
    Object.defineProperty(view,key,{enumerable:false,get(){if(!ready){value=read();ready=true;}return value;}});
  }
  return view;
}
/** Heading-policy clones retain deferred fields without consuming them. */
export function copyLazyValues<T extends Record<string, any>>(source:object,view:T):T {
  const values=recipes.get(source);return values?lazyValues(view,values):view;
}
