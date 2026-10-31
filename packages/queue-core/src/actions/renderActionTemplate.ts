import type { EventEnvelope } from '../types.js';

/**
 * Templates of the `with:` values of a `type: action` subscriber. Rendered in Node, never in a shell, in one pass (a value
 * that holds `{{ ... }}` is not rendered again). Scope: `{{ payload.a.b }}` (nested, own properties only), `{{ payload }}`
 * (the whole payload as JSON), `{{ event }}`, `{{ id }}`, `{{ timestamp }}`. A bare `{{ x }}` is an error: write `payload.x`
 * (the `cli` rule, a bare name is a payload field, is not applied here, so the two cannot be mixed up).
 */

/** Largest rendered value of one field, in bytes. */
export const MAX_RENDERED_FIELD_BYTES = 64 * 1024;

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const PAYLOAD_SEGMENT = /^[\w-]+$/;
const ENVELOPE_FIELDS = new Set(['event', 'id', 'timestamp']);
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

/** A template cannot be rendered (or never will be). The message names the field and the placeholder, never a value of the event. */
export class ActionTemplateError extends Error {
  /** The `with:` field being rendered, e.g. `with.payload.text`. */
  readonly field: string;

  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = 'ActionTemplateError';
    this.field = field;
  }
}

/** Why one placeholder expression (the text between the braces) is not in scope, undefined when it is. */
function expressionProblem(raw: string): string | undefined {
  const expression = raw.trim();
  if (expression === '') {
    return 'an empty placeholder {{ }}. Fix: write the field to insert, e.g. {{ payload.text }}.';
  }
  if (ENVELOPE_FIELDS.has(expression) || expression === 'payload') {
    return undefined;
  }
  const segments = expression.split('.');
  if (segments[0] !== 'payload') {
    const field = segments.join('.');
    return /^[\w-]+(\.[\w-]+)*$/.test(expression)
      ? `the placeholder {{ ${expression} }} is not in scope: a payload field is written {{ payload.${field} }} (the other fields are event, id, timestamp).`
      : `the placeholder {{ ${expression} }} is not valid: use {{ payload.<field> }}, {{ event }}, {{ id }} or {{ timestamp }}.`;
  }
  for (const segment of segments.slice(1)) {
    if (!PAYLOAD_SEGMENT.test(segment)) {
      return `the placeholder {{ ${expression} }} is not valid: each part after 'payload.' must be letters, digits, '_' or '-' (a nested field is {{ payload.a.b }}).`;
    }
    if (FORBIDDEN_SEGMENTS.has(segment)) {
      return `the placeholder {{ ${expression} }} is refused: '${segment}' is never read from a payload.`;
    }
  }
  return undefined;
}

/** The problem of the template syntax and scope, undefined when it is fine. Checked when the configuration is loaded, so a typo is not discovered per event. */
export function findActionTemplateProblem(template: string): string | undefined {
  for (const match of template.matchAll(PLACEHOLDER)) {
    const problem = expressionProblem(match[1]!);
    if (problem !== undefined) {
      return problem;
    }
  }
  if (template.replace(PLACEHOLDER, '').includes('{{')) {
    return "a '{{' without its closing '}}' (or a placeholder that holds braces). Fix: close it, e.g. {{ payload.text }}.";
  }
  return undefined;
}

/** The value found at the path, own properties only; undefined when any step is missing. */
function readPayloadPath(payload: unknown, segments: string[]): unknown {
  let current = payload;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function stringify(value: unknown, field: string, expression: string): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      throw new ActionTemplateError(field, `the placeholder {{ ${expression} }} holds a value that cannot be written as JSON.`);
    }
  }
  return String(value);
}

/**
 * Renders one template string against the envelope. `field` names where the template sits (`with.payload.text`) for the errors.
 * Throws ActionTemplateError: syntax or scope (also found by findActionTemplateProblem at load time), a NUL character,
 * or a rendered value over 64 KB. Every message names the field and the placeholder, never the value.
 */
export function renderActionTemplate(template: string, envelope: EventEnvelope, field: string): string {
  const syntax = findActionTemplateProblem(template);
  if (syntax !== undefined) {
    throw new ActionTemplateError(field, syntax);
  }
  const rendered = template.replace(PLACEHOLDER, (_whole, raw: string) => {
    const expression = raw.trim();
    switch (expression) {
      case 'event': return envelope.event;
      // The id of the first push, so a retry or a dlq-replay renders the same value (the WAL id changes)
      case 'id': return envelope.meta.eventId ?? envelope.id;
      case 'timestamp': return envelope.timestamp;
      case 'payload': return stringify(envelope.payload, field, expression);
      default: return stringify(readPayloadPath(envelope.payload, expression.split('.').slice(1)), field, expression);
    }
  });
  if (rendered.includes('\0')) {
    throw new ActionTemplateError(field, 'the rendered value holds a NUL character, which is refused. Fix: clean the value at its source, or do not insert that field.');
  }
  const bytes = Buffer.byteLength(rendered, 'utf8');
  if (bytes > MAX_RENDERED_FIELD_BYTES) {
    throw new ActionTemplateError(field, `the rendered value is ${bytes} bytes, over the ${MAX_RENDERED_FIELD_BYTES} bytes allowed for one field. Fix: insert a smaller field of the payload.`);
  }
  return rendered;
}
