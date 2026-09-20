type StructuralSchema=Readonly<Record<string,unknown>>;
type ExternalRefCheck=(ref:string,value:unknown)=>boolean;

const allowedKeywords=new Set([
  '$ref',
  'additionalProperties',
  'enum',
  'maximum',
  'minimum',
  'properties',
  'required',
  'type',
  'x-overcenter-providerOwned',
]);

const record=(value:unknown):value is Record<string,unknown> =>
  !!value && typeof value==='object' && !Array.isArray(value);

export function assertSupportedStructuralSchema(schema:StructuralSchema):void {
  for (const key of Object.keys(schema)) {
    if (!allowedKeywords.has(key)) {
      throw new Error(`STRUCTURAL_SCHEMA_UNSUPPORTED_KEYWORD:${key}`);
    }
  }
  if ('$ref' in schema) {
    if (typeof schema.$ref!=='string') {
      throw new Error('STRUCTURAL_SCHEMA_INVALID_REF');
    }
    return;
  }
  if ('enum' in schema) {
    if (!Array.isArray(schema.enum)) throw new Error('STRUCTURAL_SCHEMA_INVALID_ENUM');
    return;
  }
  if (schema.type==='object') {
    if (schema.required!==undefined && !Array.isArray(schema.required)) {
      throw new Error('STRUCTURAL_SCHEMA_INVALID_REQUIRED');
    }
    if (schema.properties!==undefined && !record(schema.properties)) {
      throw new Error('STRUCTURAL_SCHEMA_INVALID_PROPERTIES');
    }
    for (const child of Object.values(schema.properties??{})) {
      if (!record(child)) throw new Error('STRUCTURAL_SCHEMA_INVALID_PROPERTY');
      assertSupportedStructuralSchema(child);
    }
    if (
      schema.additionalProperties!==undefined
      && typeof schema.additionalProperties!=='boolean'
      && !record(schema.additionalProperties)
    ) throw new Error('STRUCTURAL_SCHEMA_INVALID_ADDITIONAL_PROPERTIES');
    if (record(schema.additionalProperties)) {
      assertSupportedStructuralSchema(schema.additionalProperties);
    }
    return;
  }
  if (schema.type==='string') return;
  if (schema.type==='integer') {
    if (schema.minimum!==undefined && typeof schema.minimum!=='number') {
      throw new Error('STRUCTURAL_SCHEMA_INVALID_MINIMUM');
    }
    if (schema.maximum!==undefined && typeof schema.maximum!=='number') {
      throw new Error('STRUCTURAL_SCHEMA_INVALID_MAXIMUM');
    }
    return;
  }
  throw new Error('STRUCTURAL_SCHEMA_UNSUPPORTED_SHAPE');
}

export function structurallyMatches(
  schema:StructuralSchema,
  value:unknown,
  externalRef:ExternalRefCheck=()=>false,
):boolean {
  if ('$ref' in schema) return externalRef(String(schema.$ref),value);
  if ('enum' in schema) return (schema.enum as readonly unknown[]).includes(value);

  if (schema.type==='string') return typeof value==='string';

  if (schema.type==='integer') {
    if (!Number.isInteger(value)) return false;
    const number=value as number;
    if (typeof schema.minimum==='number' && number<schema.minimum) return false;
    if (typeof schema.maximum==='number' && number>schema.maximum) return false;
    return true;
  }

  if (schema.type!=='object' || !record(value)) return false;

  const properties=record(schema.properties)?schema.properties:{};
  const required=Array.isArray(schema.required)?schema.required:[];
  for (const key of required) {
    if (typeof key!=='string' || !Object.hasOwn(value,key)) return false;
  }
  for (const [key,member] of Object.entries(value)) {
    const property=properties[key];
    if (record(property)) {
      if (!structurallyMatches(property,member,externalRef)) return false;
      continue;
    }
    if (schema.additionalProperties===true) continue;
    if (record(schema.additionalProperties)) {
      if (!structurallyMatches(schema.additionalProperties,member,externalRef)) return false;
      continue;
    }
    return false;
  }
  return true;
}
