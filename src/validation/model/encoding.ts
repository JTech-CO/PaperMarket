/** Model statistics contain finite normalized ratios and measured durations, unlike financial snapshots. */
export function canonicalModelJson(value:unknown):string {
  function encode(item:unknown):unknown {
    if(item===null||typeof item==='string'||typeof item==='boolean')return item;
    if(typeof item==='number'&&Number.isFinite(item))return item;
    if(Array.isArray(item))return item.map(encode);
    if(typeof item!=='object'||Object.getPrototypeOf(item)!==Object.prototype)throw new Error('MODEL_INVALID_JSON_SHAPE');
    return Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,child])=>[key,encode(child)]));
  }
  return JSON.stringify(encode(value));
}
