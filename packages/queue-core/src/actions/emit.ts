import { MAX_NAME_LENGTH, NAME_PATTERN } from '../catalog/EventCatalog.js';
import { isRecord } from '../isRecord.js';
import { getErrorMessage } from '../errors.js';
import type { ActionConfig, ActionPlugin, ActionResult } from './ActionPlugin.js';
import { ActionTemplateError, findActionTemplateProblem, renderActionTemplate } from './renderActionTemplate.js';
import type { EventEnvelope } from '../types.js';

const ALLOWED_KEYS = ['event', 'payload'];
// Guards a cyclic structure (a YAML alias can build one) and an absurdly nested `with.payload`
const MAX_DEPTH = 32;

/** Why `with.event` is not a concrete event name, undefined when it is. A literal: a placeholder or a wildcard would let a payload choose which subscribers fire. */
function eventNameProblem(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') {
    return "'with.event' is required: the name of the event to push, e.g. event: agent.message.";
  }
  if (value.includes('{{')) {
    return `'with.event' must be a literal event name, not a template (${JSON.stringify(value)}): a payload must not choose which event is pushed. Fix: write the name itself.`;
  }
  if (/[*>]/.test(value)) {
    return `'with.event' must be one concrete event name, not a pattern (${JSON.stringify(value)}): '*' and '>' are wildcards for subscribers.yml keys only. Fix: write the name of the event to push.`;
  }
  if (value.length > MAX_NAME_LENGTH || !NAME_PATTERN.test(value)) {
    return `'with.event' must be dot-separated segments of letters, digits, '_' or '-' (at most ${MAX_NAME_LENGTH} characters), got ${JSON.stringify(value)}.`;
  }
  return undefined;
}

/** The first template problem in the strings of `with.payload` (at any depth), undefined when there is none. */
function payloadTemplateProblem(value: unknown, path: string, depth: number): string | undefined {
  if (depth > MAX_DEPTH) {
    return `'${path}' is nested more than ${MAX_DEPTH} levels deep (or refers to itself). Fix: flatten 'with.payload'.`;
  }
  if (typeof value === 'string') {
    const problem = findActionTemplateProblem(value);
    return problem === undefined ? undefined : `'${path}': ${problem}`;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const problem = payloadTemplateProblem(value[i], `${path}[${i}]`, depth + 1);
      if (problem !== undefined) {
        return problem;
      }
    }
    return undefined;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      const problem = payloadTemplateProblem(child, `${path}.${key}`, depth + 1);
      if (problem !== undefined) {
        return problem;
      }
    }
  }
  return undefined;
}

/** Renders every string leaf of `value` (keys are kept as written). */
function renderPayload(value: unknown, envelope: EventEnvelope, path: string, depth: number): unknown {
  if (depth > MAX_DEPTH) {
    throw new ActionTemplateError(path, `nested more than ${MAX_DEPTH} levels deep (or refers to itself).`);
  }
  if (typeof value === 'string') {
    return renderActionTemplate(value, envelope, path);
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => renderPayload(item, envelope, `${path}[${i}]`, depth + 1));
  }
  if (isRecord(value)) {
    const rendered: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      // defineProperty: a key such as '__proto__' written in the YAML stays a plain own property of the new object
      Object.defineProperty(rendered, key, { value: renderPayload(child, envelope, `${path}.${key}`, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    return rendered;
  }
  return value;
}

/**
 * `action: emit`: pushes a new event from the daemon. `with.event` is the literal name, `with.payload` an object whose
 * string values are templates ({{ payload.x }}, {{ event }}, {{ id }}, {{ timestamp }}). Generic: it knows nothing of what consumes the event.
 * The event is filed under the project of the event that fired the subscriber; loops are bounded by the daemon (hop cap).
 */
export const emitAction: ActionPlugin = {
  name: 'emit',

  validate(config: ActionConfig): string | undefined {
    for (const key of Object.keys(config)) {
      if (!ALLOWED_KEYS.includes(key)) {
        return `unknown field '${key}' in 'with' (allowed: ${ALLOWED_KEYS.join(', ')}).`;
      }
    }
    const eventProblem = eventNameProblem(config['event']);
    if (eventProblem !== undefined) {
      return eventProblem;
    }
    const payload = config['payload'];
    if (payload === undefined) {
      return undefined;
    }
    if (!isRecord(payload)) {
      return "'with.payload' must be a mapping of fields, e.g. payload: { text: \"{{ payload.text }}\" }.";
    }
    return payloadTemplateProblem(payload, 'with.payload', 0);
  },

  emits(config: ActionConfig): string | undefined {
    const event = config['event'];
    return eventNameProblem(event) === undefined ? (event as string) : undefined;
  },

  async run(config: ActionConfig, envelope: EventEnvelope, context): Promise<ActionResult> {
    // Checked again at run time: the plugin is the last line before an event is pushed, whoever built the config
    const problem = emitAction.validate(config, { event: envelope.event });
    if (problem !== undefined) {
      return { success: false, permanent: true, error: `action 'emit' is misconfigured: ${problem}` };
    }
    const event = config['event'] as string;
    let payload: unknown;
    try {
      payload = renderPayload(config['payload'] ?? {}, envelope, 'with.payload', 0);
    } catch (err) {
      if (err instanceof ActionTemplateError) {
        return { success: false, permanent: true, error: `action 'emit' cannot render ${err.message}` };
      }
      return { success: false, permanent: true, error: `action 'emit' cannot render 'with.payload': ${getErrorMessage(err)}` };
    }
    const pushed = await context.push({ event, payload });
    if (!pushed.success) {
      return { success: false, error: pushed.error ?? `the event '${event}' was not accepted`, ...(pushed.permanent === true && { permanent: true as const }) };
    }
    return { success: true, detail: `emitted '${event}'${pushed.eventId === undefined ? '' : ` (${pushed.eventId})`}` };
  },
};
