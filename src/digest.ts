import { createHash } from 'node:crypto';

export function sha256(value:string):string {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalStringCompare(left:string,right:string):number {
  const leftChars=[...left];
  const rightChars=[...right];
  const length=Math.min(leftChars.length,rightChars.length);
  for (let index=0;index<length;index+=1) {
    const leftCodePoint=leftChars[index].codePointAt(0)!;
    const rightCodePoint=rightChars[index].codePointAt(0)!;
    if (leftCodePoint<rightCodePoint) return -1;
    if (leftCodePoint>rightCodePoint) return 1;
  }
  if (leftChars.length<rightChars.length) return -1;
  if (leftChars.length>rightChars.length) return 1;
  return 0;
}

export function canonicalJson(value:unknown):string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value && typeof value==='object') {
    const entries=Object.entries(value as Record<string,unknown>)
      .sort(([left],[right])=>canonicalStringCompare(left,right));
    return `{${entries.map(([key,item])=>{
      const encodedKey=JSON.stringify(key);
      return `${encodedKey}:${canonicalJson(item)}`;
    }).join(',')}}`;
  }
  const encoded=JSON.stringify(value);
  if (encoded===undefined) {
    throw new Error('CANONICAL_JSON_UNSUPPORTED_VALUE');
  }
  return encoded;
}

export function canonicalDigest(value:unknown):string {
  return sha256(canonicalJson(value));
}
