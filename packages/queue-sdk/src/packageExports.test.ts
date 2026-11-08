import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The package as a consumer gets it: the BUILT output (dist/esm from tsc, dist/cjs from ci/build-cjs.mjs) resolved through the `exports`
// map by a separate node process, once with require() and once with import. Nothing else loads dist/cjs, so a broken CJS bundle or a
// wrong exports entry would otherwise be published unseen. `npm test` of this package builds first (pretest).

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');

interface Seen {
  index: string[];
  protocol: string[];
  testing: string[];
  protocolVersion: string;
  statusOfOffPublisher: { available: boolean };
  droppedWhenOff: { status: string };
  fakeDaemonWorks: boolean;
}

// The same checks in both module systems; prints one JSON line
const CHECK_BODY = `
  const index = load('@wadeck-app/queue-sdk');
  const protocol = load('@wadeck-app/queue-sdk/protocol');
  const testing = load('@wadeck-app/queue-sdk/testing');
  const publisher = index.createQueuePublisher({ silent: true, off: true });
  const statusOfOffPublisher = await publisher.status();
  const droppedWhenOff = await publisher.publishAndWait('app.thing', {});
  const daemon = await testing.startFakeQueueDaemon();
  let fakeDaemonWorks = false;
  try {
    const live = index.createQueuePublisher({ silent: true, configDir: daemon.configDir });
    const result = await live.publishAndWait('app.thing', { a: 1 });
    fakeDaemonWorks = result.status === 'queued' && daemon.pushes().length === 1;
  } finally {
    await daemon.close();
  }
  console.log(JSON.stringify({
    index: Object.keys(index).sort(),
    protocol: Object.keys(protocol).sort(),
    testing: Object.keys(testing).sort(),
    protocolVersion: index.PROTOCOL_VERSION,
    statusOfOffPublisher,
    droppedWhenOff,
    fakeDaemonWorks,
  }));
`;

const CJS_SCRIPT = `(async () => { const load = require; ${CHECK_BODY} })().catch((error) => { console.error(error); process.exit(1); });`;
const ESM_SCRIPT = `const index = await import('@wadeck-app/queue-sdk');
  const protocol = await import('@wadeck-app/queue-sdk/protocol');
  const testing = await import('@wadeck-app/queue-sdk/testing');
  const publisher = index.createQueuePublisher({ silent: true, off: true });
  const statusOfOffPublisher = await publisher.status();
  const droppedWhenOff = await publisher.publishAndWait('app.thing', {});
  const daemon = await testing.startFakeQueueDaemon();
  let fakeDaemonWorks = false;
  try {
    const live = index.createQueuePublisher({ silent: true, configDir: daemon.configDir });
    const result = await live.publishAndWait('app.thing', { a: 1 });
    fakeDaemonWorks = result.status === 'queued' && daemon.pushes().length === 1;
  } finally {
    await daemon.close();
  }
  console.log(JSON.stringify({
    index: Object.keys(index).sort(),
    protocol: Object.keys(protocol).sort(),
    testing: Object.keys(testing).sort(),
    protocolVersion: index.PROTOCOL_VERSION,
    statusOfOffPublisher,
    droppedWhenOff,
    fakeDaemonWorks,
  }));
`;

// What a program that depends on the SDK may rely on. Adding an export is deliberate: update the list in the same change.
const INDEX_NAMES = ['PROTOCOL_VERSION', 'createQueuePublisher', 'resolveConfigDir'];
const PROTOCOL_NAMES = [
  'DAEMON_ACCEPTS',
  'EVENT_CATALOG_MIN_VERSION',
  'LEGACY_DAEMON_PROTOCOL',
  'MAX_PUSH_PAYLOAD_BYTES',
  'PROTOCOL_VERSION',
  'PUSH_DIRECTIONS',
  'PUSH_DIRECTION_MIN_VERSION',
  'PUSH_PAYLOAD_RULES_MIN_VERSION',
  'PUSH_PROJECT_MIN_VERSION',
  'PUSH_WITHOUT_CWD_MIN_VERSION',
  'ProtocolError',
  'RESERVED_EVENT_PREFIX',
  'RESERVED_NAMESPACE_MIN_VERSION',
  'SDK_UNDERSTANDS',
  'checkClientProtocol',
  'checkPushDirection',
  'daemonSupportsEventCatalog',
  'daemonSupportsPushDirection',
  'daemonSupportsPushProject',
  'daemonSupportsPushWithoutCwd',
  'isReservedEventName',
  'negotiate',
  'parseDaemonProtocol',
  'payloadSizeProblem',
];
const TESTING_NAMES = ['startFakeQueueDaemon'];

let consumerDir: string;

beforeAll(() => {
  for (const built of ['dist/esm/index.js', 'dist/cjs/index.cjs', 'dist/cjs/protocol.cjs', 'dist/cjs/testing.cjs']) {
    if (!existsSync(join(packageDir, built))) {
      throw new Error(`${join(packageDir, built)} does not exist: build the package first (\`npm run build --workspace=packages/queue-sdk\`, which runs tsc and ci/build-cjs.mjs). This test loads the built output through the exports map and must not be skipped.`);
    }
  }
  // A consumer's node_modules holding what is published: package.json and the dist folder (the "files" of the package)
  consumerDir = mkdtempSync(join(tmpdir(), 'queue-sdk-exports-'));
  const installed = join(consumerDir, 'node_modules', '@wadeck-app', 'queue-sdk');
  mkdirSync(installed, { recursive: true });
  cpSync(join(packageDir, 'package.json'), join(installed, 'package.json'));
  cpSync(join(packageDir, 'dist'), join(installed, 'dist'), { recursive: true });
  writeFileSync(join(consumerDir, 'consumer.cjs'), CJS_SCRIPT);
  writeFileSync(join(consumerDir, 'consumer.mjs'), ESM_SCRIPT);
});

afterAll(() => {
  if (consumerDir !== undefined) {
    rmSync(consumerDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

function runConsumer(file: string): Seen {
  const out = execFileSync(process.execPath, [join(consumerDir, file)], { cwd: consumerDir, encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop() ?? '') as Seen;
}

describe.each([
  ['require (dist/cjs)', 'consumer.cjs'],
  ['import (dist/esm)', 'consumer.mjs'],
])('@wadeck-app/queue-sdk loaded through its exports map with %s', (_name, file) => {
  it('exposes the documented public API on the root, ./protocol and ./testing entries', () => {
    const seen = runConsumer(file);
    expect(seen.index).toEqual(INDEX_NAMES);
    expect(seen.protocol).toEqual(PROTOCOL_NAMES);
    expect(seen.testing).toEqual(TESTING_NAMES);
  });

  it('runs: an off publisher answers dropped, and a publisher pushes to the fake daemon of ./testing', () => {
    const seen = runConsumer(file);
    expect(seen.protocolVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(seen.statusOfOffPublisher.available).toBe(false);
    expect(seen.droppedWhenOff.status).toBe('dropped');
    expect(seen.fakeDaemonWorks).toBe(true);
  });
});

describe('both module systems agree', () => {
  it('require and import give the same names and the same protocol version', () => {
    const required = runConsumer('consumer.cjs');
    const imported = runConsumer('consumer.mjs');
    expect(required).toEqual(imported);
  });
});
