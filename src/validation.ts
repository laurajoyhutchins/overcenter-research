export type Data=Record<string,unknown>;

export function isData(value:unknown):value is Data {
  return !!value && typeof value==='object' && !Array.isArray(value);
}

export function asData(value:unknown):Data|null {
  return isData(value)?value:null;
}

export function hasExactKeys(
  value:Data,
  required:readonly string[],
  optional:readonly string[]=[],
):boolean {
  const allowed=new Set([...required,...optional]);
  return Object.keys(value).every(key=>allowed.has(key))
    && required.every(key=>Object.hasOwn(value,key));
}

export function assertExactKeys(
  value:Data,
  required:readonly string[],
  optional:readonly string[],
  error:string,
):void {
  const allowed=new Set([...required,...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${error}:UNKNOWN_FIELD:${key}`);
  }
  for (const key of required) {
    if (!(key in value)) throw new Error(`${error}:MISSING_FIELD:${key}`);
  }
}

export function assertNonEmptyString(
  value:unknown,
  error:string,
):asserts value is string {
  if (typeof value!=='string' || value.length===0 || value.includes('\0')) {
    throw new Error(error);
  }
}
