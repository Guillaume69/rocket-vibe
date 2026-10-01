import { nativeSchema, type NativeTypes } from './protocol.generated.ts';

type Schema = {
  $ref?: string;
  type?: string | readonly string[];
  const?: unknown;
  enum?: readonly unknown[];
  anyOf?: readonly Schema[];
  oneOf?: readonly Schema[];
  items?: Schema;
  properties?: Readonly<Record<string, Schema>>;
  required?: readonly string[];
  additionalProperties?: boolean;
};

const definitions: Readonly<Record<string, Schema>> = nativeSchema.$defs;

function valid(schema: Schema, value: unknown): boolean {
  if (Array.isArray(schema.type)) return schema.type.some(type => valid({...schema,type},value));
  if (schema.$ref) return valid(definitions[schema.$ref.split('/').at(-1) ?? ''] ?? {}, value);
  if ('const' in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (alternatives) return alternatives.some(s => valid(s, value));
  switch (schema.type) {
    case 'string': return typeof value === 'string';
    case 'boolean': return typeof value === 'boolean';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isSafeInteger(value);
    case 'null': return value === null;
    case 'array': return Array.isArray(value) && value.every(v => valid(schema.items ?? {}, v));
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
      const object = value as Record<string, unknown>;
      if (schema.required?.some(k => !Object.hasOwn(object, k))) return false;
      if (schema.additionalProperties === false && Object.keys(object).some(k => !(k in (schema.properties ?? {})))) return false;
      return Object.entries(schema.properties ?? {}).every(([key, property]) => !Object.hasOwn(object, key) || valid(property, object[key]));
    }
    default: return 'const' in schema || schema.enum !== undefined;
  }
}

export function decodeNative<K extends keyof NativeTypes>(name: K, value: unknown): NativeTypes[K] {
  if (!valid(definitions[name], value)) throw new Error(`Invalid RocketVibe ${name}`);
  return value as NativeTypes[K];
}
