import { isDeepStrictEqual } from 'node:util';
import { fail, object } from './validation.mjs';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const unsafeKey = key => ['__proto__', 'prototype', 'constructor'].includes(key);
const types = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];
const annotations = ['title', 'description', 'default', 'examples', 'readOnly', 'writeOnly', 'deprecated'];
const keywords = new Set(['$schema', 'type', 'properties', 'required', 'additionalProperties', 'items',
  'minItems', 'maxItems', 'uniqueItems', 'minLength', 'maxLength', 'minimum', 'maximum',
  'exclusiveMinimum', 'exclusiveMaximum', 'minProperties', 'maxProperties', 'enum', 'const',
  'anyOf', 'oneOf', 'allOf', ...annotations]);

/** Bound all JSON before inspecting schemas, arguments, or structured results. */
export function boundedMcpJson(value, status = 400) {
  let nodes = 0;
  const visit = (item, depth) => {
    if (++nodes > 4096 || depth > 16) fail(status, 'MCP JSON exceeds its structure limit.');
    if (typeof item === 'string') {
      if (!item.isWellFormed() || Buffer.byteLength(item) > 65536 || item.includes('\0')) fail(status, 'MCP JSON contains invalid or oversized text.');
    } else if (typeof item === 'number') {
      if (!Number.isFinite(item)) fail(status, 'MCP JSON contains an invalid number.');
    } else if (Array.isArray(item)) {
      for (const child of item) visit(child, depth + 1);
    } else if (record(item)) {
      for (const [key, child] of Object.entries(item)) {
        if (!key.isWellFormed() || key.length > 256 || /[\x00-\x1f\x7f]/.test(key) || unsafeKey(key)) fail(status, 'MCP JSON contains an unsupported object key.');
        visit(child, depth + 1);
      }
    } else if (item !== null && typeof item !== 'boolean') fail(status, 'MCP data must be JSON.');
  };
  visit(value, 0);
  return value;
}

/** Fail closed on unsupported validation keywords. No remote references or regex evaluation. */
export function mcpSchema(value) {
  boundedMcpJson(value, 502);
  object(value, 'MCP schema');
  if (Buffer.byteLength(JSON.stringify(value)) > 16384 || value.type !== 'object') fail(502, 'MCP schemas must be object schemas of at most 16 KiB.');
  let nodes = 0;
  const visit = (schema, depth) => {
    if (++nodes > 128 || depth > 8) fail(502, 'MCP schema exceeds its complexity limit.');
    if (typeof schema === 'boolean') return;
    if (!record(schema) || Object.keys(schema).some(key => !keywords.has(key))) fail(502, 'MCP schema uses an unsupported keyword.');
    if (schema.$schema !== undefined && !['https://json-schema.org/draft/2020-12/schema', 'http://json-schema.org/draft-07/schema#'].includes(schema.$schema)) fail(502, 'Unsupported MCP JSON Schema dialect.');
    if (schema.type !== undefined) {
      const selected = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (!selected.length || selected.length > types.length || new Set(selected).size !== selected.length || selected.some(type => !types.includes(type))) fail(502, 'MCP schema has an invalid type.');
    }
    for (const key of ['minItems', 'maxItems', 'minLength', 'maxLength', 'minProperties', 'maxProperties']) {
      if (schema[key] !== undefined && (!Number.isSafeInteger(schema[key]) || schema[key] < 0 || schema[key] > 1000000)) fail(502, 'MCP schema has an invalid size bound.');
    }
    for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']) {
      if (schema[key] !== undefined && (typeof schema[key] !== 'number' || !Number.isFinite(schema[key]))) fail(502, 'MCP schema has an invalid numeric bound.');
    }
    for (const key of ['uniqueItems', 'readOnly', 'writeOnly', 'deprecated']) if (schema[key] !== undefined && typeof schema[key] !== 'boolean') fail(502, 'MCP schema has an invalid boolean.');
    for (const key of ['title', 'description']) if (schema[key] !== undefined && (typeof schema[key] !== 'string' || schema[key].length > 4096)) fail(502, 'MCP schema annotation is invalid or too large.');
    if (schema.examples !== undefined && (!Array.isArray(schema.examples) || schema.examples.length > 32)) fail(502, 'MCP schema examples exceed their limit.');
    if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length || schema.enum.length > 32)) fail(502, 'MCP schema enum is invalid or too large.');
    if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.length > 128 || new Set(schema.required).size !== schema.required.length || schema.required.some(key => typeof key !== 'string' || key.length > 256 || unsafeKey(key)))) fail(502, 'MCP schema required fields are invalid.');
    if (schema.properties !== undefined) {
      if (!record(schema.properties) || Object.keys(schema.properties).length > 128) fail(502, 'MCP schema properties exceed their limit.');
      for (const child of Object.values(schema.properties)) visit(child, depth + 1);
    }
    if (schema.additionalProperties !== undefined) visit(schema.additionalProperties, depth + 1);
    if (schema.items !== undefined) visit(schema.items, depth + 1);
    for (const key of ['anyOf', 'oneOf', 'allOf']) if (schema[key] !== undefined) {
      if (!Array.isArray(schema[key]) || !schema[key].length || schema[key].length > 8) fail(502, 'MCP schema alternatives exceed their limit.');
      for (const child of schema[key]) visit(child, depth + 1);
    }
  };
  visit(value, 0);
  return structuredClone(value);
}

export function validateMcpValue(value, schema, status = 400) {
  boundedMcpJson(value, status);
  let steps = 0;
  const matches = (item, rule) => {
    if (++steps > 20000) fail(status, 'MCP schema validation exceeded its work limit.');
    if (typeof rule === 'boolean') return rule;
    if (rule.type !== undefined) {
      const selected = Array.isArray(rule.type) ? rule.type : [rule.type];
      if (!selected.some(type => type === 'null' ? item === null : type === 'object' ? record(item)
        : type === 'array' ? Array.isArray(item) : type === 'integer' ? Number.isSafeInteger(item)
        : type === 'number' ? typeof item === 'number' && Number.isFinite(item) : typeof item === type)) return false;
    }
    if (Object.hasOwn(rule, 'const') && !isDeepStrictEqual(item, rule.const)) return false;
    if (rule.enum && !rule.enum.some(choice => isDeepStrictEqual(item, choice))) return false;
    if (rule.allOf && !rule.allOf.every(child => matches(item, child))) return false;
    if (rule.anyOf && !rule.anyOf.some(child => matches(item, child))) return false;
    if (rule.oneOf && rule.oneOf.filter(child => matches(item, child)).length !== 1) return false;
    if (typeof item === 'number') {
      if (rule.minimum !== undefined && item < rule.minimum || rule.maximum !== undefined && item > rule.maximum
        || rule.exclusiveMinimum !== undefined && item <= rule.exclusiveMinimum || rule.exclusiveMaximum !== undefined && item >= rule.exclusiveMaximum) return false;
    }
    if (typeof item === 'string') {
      const length = [...item].length;
      if (rule.minLength !== undefined && length < rule.minLength || rule.maxLength !== undefined && length > rule.maxLength) return false;
    }
    if (Array.isArray(item)) {
      if (rule.minItems !== undefined && item.length < rule.minItems || rule.maxItems !== undefined && item.length > rule.maxItems) return false;
      if (rule.items !== undefined && !item.every(child => matches(child, rule.items))) return false;
      if (rule.uniqueItems) for (let index = 0; index < item.length; index++) for (let other = index + 1; other < item.length; other++) {
        if (++steps > 20000) fail(status, 'MCP schema validation exceeded its work limit.');
        if (isDeepStrictEqual(item[index], item[other])) return false;
      }
    }
    if (record(item)) {
      const keys = Object.keys(item);
      if (rule.minProperties !== undefined && keys.length < rule.minProperties || rule.maxProperties !== undefined && keys.length > rule.maxProperties) return false;
      if (rule.required?.some(key => !Object.hasOwn(item, key))) return false;
      for (const key of keys) {
        if (rule.properties && Object.hasOwn(rule.properties, key)) { if (!matches(item[key], rule.properties[key])) return false; }
        else if (rule.additionalProperties !== undefined && !matches(item[key], rule.additionalProperties)) return false;
      }
    }
    return true;
  };
  if (!matches(value, schema)) fail(status, 'MCP data does not match the reviewed tool schema.');
  return value;
}
