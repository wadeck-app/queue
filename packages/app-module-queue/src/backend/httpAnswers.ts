import { describeWaiting, type PushResponse, type DlqReplayResponse, type DlqClearResponse, type RetryResponse } from '@wadeck-app/queue-core';

/**
 * What the module answers to the dashboard for what the daemon answered. The daemon reports a refusal as a normal answer ("rejected", "aborted",
 * "not-found"...), and the module used to forward it as HTTP 200: the toast then said "pushed" or "removed" for an operation that did nothing. The shell shows a
 * failure from the `message` (else `error`) of the JSON body, so a refusal is a 4xx with its explanation in `error`, and a success that needs a caveat carries it in `message`.
 */
export interface HttpAnswer {
  code: number;
  body: unknown;
}

const GENERIC_PUSH_FIX = 'Fix: change the event name or the payload as the reason says; if the daemon is older than the dashboard, restart it (queue stop, then the next push starts it again).';

const UNKNOWN_ANSWER_FIX = "Fix: dashboard and daemon do not agree on the protocol; restart the daemon (queue stop, then the next push starts it again) and check 'queue history'.";

function describeStatus(status: unknown): string {
  return status === undefined ? 'no status' : `the status ${JSON.stringify(status)}`;
}

/** A push, a test push or a replay (all answered with a PushResponse). */
export function pushAnswer(response: PushResponse): HttpAnswer {
  if (response.status === 'rejected') {
    const reason = response.reason ?? 'no reason given';
    const accepted = response.supported !== undefined ? ` The daemon accepts clients ${response.supported}.` : '';
    // A reason that already ends with its own fix is not followed by a generic one
    const fix = reason.includes('Fix:') ? '' : ` ${GENERIC_PUSH_FIX}`;
    return { code: 422, body: { error: `The daemon rejected the push, nothing was recorded or run: ${reason}.${accepted}${fix}` } };
  }
  if (response.status === 'aborted') {
    return {
      code: 422,
      body: { error: `A subscriber aborted the event: ${response.reason ?? 'no reason given'}. The event was not delivered. Fix: change the payload as that reason says, or the subscriber that aborts (subscribers.yml).` },
    };
  }
  // An explicit 0 only: an answer without a count (an older daemon) is not claimed to have no subscriber
  if (response.status === 'queued' && response.subscriberCount === 0) {
    return { code: 200, body: { ...response, message: noSubscriberMessage(response) } };
  }
  // Anything else than dispatched / queued is an answer this module does not know: not claimed as a success
  if (response.status !== 'queued' && response.status !== 'dispatched') {
    return { code: 502, body: { error: `The daemon answered the push with ${describeStatus(response.status)}, so it cannot be confirmed that the event was recorded or run. ${UNKNOWN_ANSWER_FIX}` } };
  }
  return { code: 200, body: response };
}

/** Where a push came from, for the answer: a registered project, an explicit folder, or (neither) the working directory of the dashboard process. */
export type PushOrigin = { kind: 'project'; projectName: string; cwd: string } | { kind: 'cwd'; cwd: string } | { kind: 'process'; cwd: string };

function originNote(origin: PushOrigin): string {
  if (origin.kind === 'project') {
    return `Pushed with the working directory of project "${origin.projectName}": ${origin.cwd}.`;
  }
  if (origin.kind === 'cwd') {
    return `Pushed with the working directory ${origin.cwd}.`;
  }
  return `Pushed with the working directory of the dashboard process (${origin.cwd}): subscribers limited to a project do not match from there. Fix: give "project" (the id of a registered project) to push from that project.`;
}

/** Adds to the `message` of a successful push the working directory it was matched against (the subscribers of a project only match their own). A refusal is left as it is. */
export function withPushOrigin(answer: HttpAnswer, origin: PushOrigin): HttpAnswer {
  if (answer.code !== 200 || typeof answer.body !== 'object' || answer.body === null) {
    return answer;
  }
  const body = answer.body as { message?: string };
  const note = originNote(origin);
  return { code: 200, body: { ...body, message: body.message === undefined ? note : `${body.message} ${note}` } };
}

export function dlqReplayAnswer(response: DlqReplayResponse, id: string): HttpAnswer {
  if (response.status === 'not-found') {
    return { code: 404, body: { error: `No DLQ entry with id ${id}: it was already replayed or cleared. Reload the page.` } };
  }
  if (response.status === 'error') {
    return { code: 409, body: { error: response.message ?? `The daemon did not replay DLQ entry ${id} and gave no reason. The entry is still in the dead-letter queue. Fix: 'queue logs' has the reason in the daemon log.` } };
  }
  if (response.status !== 'ok') {
    return { code: 502, body: { error: `The daemon answered the replay of DLQ entry ${id} with ${describeStatus(response.status)}, so it cannot be confirmed that the entry was replayed. ${UNKNOWN_ANSWER_FIX}` } };
  }
  return { code: 200, body: response };
}

export function dlqClearAnswer<T extends DlqClearResponse>(response: T, id: string): HttpAnswer {
  if (response.reason !== undefined) {
    return { code: 400, body: { error: response.reason } };
  }
  if (typeof response.cleared !== 'number') {
    return { code: 502, body: { error: `The daemon answered the clear of DLQ entry ${id} with no count, so it cannot be confirmed that anything was cleared. ${UNKNOWN_ANSWER_FIX}` } };
  }
  if (response.cleared === 0) {
    return { code: 404, body: { error: `no such DLQ entry: ${id} was already cleared or replayed. Reload the page.` } };
  }
  return { code: 200, body: response };
}

export function retryAnswer(response: RetryResponse, eventId: string): HttpAnswer {
  if (response.status === 'not-found') {
    return { code: 404, body: { error: `No pending event with id ${eventId} (retry only applies to events still in the WAL)` } };
  }
  if (response.message !== undefined) {
    return { code: 409, body: { error: response.message } };
  }
  if (response.status !== 'ok') {
    return { code: 500, body: { error: `The daemon refused to retry ${eventId} and gave no reason. Fix: 'queue logs' has the reason in the daemon log.` } };
  }
  return { code: 200, body: response };
}

const CHECK_NAME = 'Check the event name and the project (the Subscribers page lists who listens).';

/**
 * Nobody subscribes to a queued event. Protocol 1.7.0 daemons also say who was waiting for it (`queue wait`): a wait sees the event in the history, so then it is not
 * "nothing will run". An answer without `waiterCount` (an older daemon, or one that could not look) keeps the original text.
 */
function noSubscriberMessage(response: PushResponse): string {
  if (response.waiterCount === undefined) {
    return `queued, but no subscriber matches this event: nothing will run. ${CHECK_NAME}`;
  }
  if (response.waiterCount === 0) {
    return `queued, but no subscriber matches this event and no one is waiting for it: nothing will run. ${CHECK_NAME}`;
  }
  return `queued: no subscriber matches this event, but ${describeWaiting(response.waiterCount, response.waiters)} (a wait sees it in the history). No subscriber will run. ${CHECK_NAME}`;
}
