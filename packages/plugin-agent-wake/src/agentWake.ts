import {
  ActionTemplateError, findActionTemplateProblem, renderActionTemplate,
  type ActionConfig, type ActionPlugin, type ActionResult, type EventEnvelope,
} from '@wadeck-app/queue-core';

/** The only event this action emits: the contract of w-agent-wake. */
export const AGENT_MESSAGE_EVENT = 'agent.message';

/** Largest `text`, in bytes (UTF-8), after rendering. */
export const MAX_TEXT_BYTES = 16 * 1024;
const MAX_TO_LENGTH = 200;
const MAX_FROM_LENGTH = 200;
const MAX_REF_LENGTH = 200;

/** What `from` is when the subscriber does not say: the event that fired the action, e.g. `queue:on.github.push`. */
const DEFAULT_FROM = 'queue:{{ event }}';
/** What `ref` is when the subscriber does not say: the id of the source event, stable across retries and replays, so a consumer can ignore a duplicate. */
const DEFAULT_REF = '{{ id }}';

const ALLOWED_KEYS = ['to', 'text', 'from', 'mode', 'ref'];
const MODES = ['wake', 'passive'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 1 to 200 characters after 'project:': spaces, parentheses and accents are fine; control characters and line breaks are not
const PROJECT_TARGET = /^project:[^\p{Cc}\u2028\u2029]{1,200}$/u;
// A one-line value: no control character, no line break
const ONE_LINE = /^[^\p{Cc}\u2028\u2029]*$/u;

const TO_RULE = "a session id (a UUID) or 'project:<folder>' (1 to 200 characters, no control characters or line breaks)";

/** Why a final (rendered or literal) `to` is not an accepted recipient, undefined when it is. */
function toProblem(value: string): string | undefined {
  if (UUID.test(value)) {
    return undefined;
  }
  if (PROJECT_TARGET.test(value) && value.slice('project:'.length).trim() !== '') {
    return undefined;
  }
  return `'to' must be ${TO_RULE}, got ${JSON.stringify(value.length > 80 ? `${value.slice(0, 80)}...` : value)}`;
}

/** Why a template of `with` is wrong as written (syntax, scope), undefined when it is fine. */
function templateProblem(field: string, value: string): string | undefined {
  const problem = findActionTemplateProblem(value);
  return problem === undefined ? undefined : `'${field}': ${problem}`;
}

function optionalOneLine(config: ActionConfig, field: 'from' | 'ref', max: number): string | undefined {
  const value = config[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value === '') {
    return `'${field}' must be a non-empty string when given (default ${JSON.stringify(field === 'from' ? DEFAULT_FROM : DEFAULT_REF)}).`;
  }
  if (!ONE_LINE.test(value)) {
    return `'${field}' must be one line without control characters.`;
  }
  const template = templateProblem(field, value);
  if (template !== undefined) {
    return template;
  }
  if ([...value].length > max && !value.includes('{{')) {
    return `'${field}' is ${[...value].length} characters, over the ${max} allowed.`;
  }
  return undefined;
}

function validate(config: ActionConfig): string | undefined {
  for (const key of Object.keys(config)) {
    if (!ALLOWED_KEYS.includes(key)) {
      return `unknown field '${key}' in 'with' (allowed: ${ALLOWED_KEYS.join(', ')}).`;
    }
  }
  const to = config['to'];
  if (typeof to !== 'string' || to === '') {
    return `'to' is required: ${TO_RULE}, or a placeholder such as "{{ payload.session }}" (checked when the action runs). Example: to: "project:my-app".`;
  }
  if (to.includes('{{')) {
    const template = templateProblem('to', to);
    if (template !== undefined) {
      return template;
    }
    // Whatever the placeholders render to, the text around them is fixed: it must already be a possible start of a recipient
    const literal = to.replace(/\{\{[^{}]*\}\}/g, '');
    if (!ONE_LINE.test(literal)) {
      return "'to' must not contain control characters or line breaks.";
    }
    if (!to.trim().startsWith('{{') && !to.startsWith('project:')) {
      return `'to' must be ${TO_RULE}: a template has to start with a placeholder (the whole value) or with 'project:'.`;
    }
  } else {
    const problem = toProblem(to);
    if (problem !== undefined) {
      return problem;
    }
  }

  const text = config['text'];
  if (typeof text !== 'string' || text === '') {
    return `'text' is required: the message the session receives, e.g. text: "CI failed on {{ payload.branch }}" (at most ${MAX_TEXT_BYTES} bytes once rendered).`;
  }
  const textTemplate = templateProblem('text', text);
  if (textTemplate !== undefined) {
    return textTemplate;
  }
  if (!text.includes('{{') && Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) {
    return `'text' is ${Buffer.byteLength(text, 'utf8')} bytes, over the ${MAX_TEXT_BYTES} bytes allowed.`;
  }

  const from = optionalOneLine(config, 'from', MAX_FROM_LENGTH);
  if (from !== undefined) {
    return from;
  }
  const ref = optionalOneLine(config, 'ref', MAX_REF_LENGTH);
  if (ref !== undefined) {
    return ref;
  }

  const mode = config['mode'];
  if (mode !== undefined && (typeof mode !== 'string' || !MODES.includes(mode))) {
    return `'mode' must be one of ${MODES.join(', ')} (a literal: a payload must not choose it), got ${JSON.stringify(mode)}. 'passive' is the safe choice for an untrusted source.`;
  }
  return undefined;
}

/** Renders one field and checks the rendered value; throws ActionTemplateError that names the field. */
function renderField(field: string, template: string, envelope: EventEnvelope, check: (rendered: string) => string | undefined): string {
  const rendered = renderActionTemplate(template, envelope, `with.${field}`);
  const problem = check(rendered);
  if (problem !== undefined) {
    throw new ActionTemplateError(`with.${field}`, problem);
  }
  return rendered;
}

function oneLineCheck(field: string, max: number): (rendered: string) => string | undefined {
  return (rendered) => {
    if (rendered === '') {
      return `'${field}' rendered empty (the placeholder points at a missing payload field). Fix: check the field name, or write a literal.`;
    }
    if (!ONE_LINE.test(rendered)) {
      return `'${field}' rendered with a control character or a line break, which is refused.`;
    }
    const length = [...rendered].length;
    return length > max ? `'${field}' rendered ${length} characters, over the ${max} allowed.` : undefined;
  };
}

async function run(config: ActionConfig, envelope: EventEnvelope, context: Parameters<ActionPlugin['run']>[2]): Promise<ActionResult> {
  // The last line before an event is pushed, whoever built the config
  const configProblem = validate(config);
  if (configProblem !== undefined) {
    return { success: false, permanent: true, error: `action 'agent-wake' is misconfigured: ${configProblem}` };
  }
  let payload: Record<string, string>;
  try {
    const to = renderField('to', config['to'] as string, envelope, (rendered) => toProblem(rendered));
    const text = renderField('text', config['text'] as string, envelope, (rendered) => {
      if (rendered.trim() === '') {
        return "'text' rendered empty (the placeholder points at a missing payload field). Fix: check the field name.";
      }
      const bytes = Buffer.byteLength(rendered, 'utf8');
      return bytes > MAX_TEXT_BYTES ? `'text' rendered ${bytes} bytes, over the ${MAX_TEXT_BYTES} bytes allowed. Fix: insert a smaller field of the payload.` : undefined;
    });
    const from = renderField('from', (config['from'] as string | undefined) ?? DEFAULT_FROM, envelope, oneLineCheck('from', MAX_FROM_LENGTH));
    const ref = renderField('ref', (config['ref'] as string | undefined) ?? DEFAULT_REF, envelope, oneLineCheck('ref', MAX_REF_LENGTH));
    payload = { to, text, from, mode: (config['mode'] as string | undefined) ?? 'wake', ref };
  } catch (err) {
    if (err instanceof ActionTemplateError) {
      return { success: false, permanent: true, error: `action 'agent-wake' cannot send the message: ${err.message}` };
    }
    throw err;
  }
  const pushed = await context.push({ event: AGENT_MESSAGE_EVENT, payload });
  if (!pushed.success) {
    return { success: false, error: pushed.error ?? `the event '${AGENT_MESSAGE_EVENT}' was not accepted`, ...(pushed.permanent === true && { permanent: true as const }) };
  }
  // The recipient and the text are not logged: the text may come from an untrusted webhook, and it is in the emitted event anyway
  return { success: true, detail: `emitted '${AGENT_MESSAGE_EVENT}' (${pushed.eventId ?? 'no id'}) mode ${payload['mode']}` };
}

/**
 * `action: agent-wake`: a strict preset over `emit` for the one contract of w-agent-wake. It emits `agent.message { to, text, from, mode, ref }`
 * and validates what `emit` would let through: the recipient is a session id or `project:<folder>` (also once a placeholder is rendered, so a payload
 * cannot aim the message at an arbitrary target), the text is capped, `mode` is a literal. `from` defaults to `queue:{{ event }}`, `mode` to wake,
 * `ref` to `{{ id }}` (the id of the first push: stable across retries, so the consumer can ignore a duplicate).
 */
export const agentWakeAction: ActionPlugin = {
  name: 'agent-wake',
  validate,
  emits: () => AGENT_MESSAGE_EVENT,
  events: [
    {
      name: AGENT_MESSAGE_EVENT,
      description: 'agent.message { to, text, from?, mode?, ref? }: wake an idle Claude Code session (to = session id or project:<folder>)',
      schema: {
        type: 'object',
        required: ['to', 'text'],
        properties: {
          to: { type: 'string', description: 'Session id (UUID) or project:<folder>' },
          text: { type: 'string', description: 'The message the session receives' },
          from: { type: 'string', description: 'Who sends it, e.g. queue:on.github.push' },
          mode: { type: 'string', enum: MODES, description: 'wake (default) wakes an idle session; passive only queues the message' },
          ref: { type: 'string', description: 'Idempotence key: the same ref is the same message (delivery is at least once)' },
        },
      },
      example: { to: 'project:my-app', text: 'CI failed on main', from: 'queue:on.github.check_run', mode: 'wake', ref: 'c0ffee00-0000-4000-8000-000000000000' },
    },
  ],
  run,
};
