// violations-suppress: ts/no-barrel-index package entry point (package.json main/types): its exports are the package's public API, deleting it would expose dist internals to every consumer
export { agentWakeAction, AGENT_MESSAGE_EVENT, MAX_TEXT_BYTES } from './agentWake.js';
