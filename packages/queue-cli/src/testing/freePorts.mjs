// Prints N free TCP ports (one per line), at least 32 apart from each other, then exits. Run synchronously by createIsolatedCliEnv (see
// isolatedCliEnv.ts): Node cannot bind a socket synchronously, a child process can. The kit's daemons walk up to 10 ports further when theirs
// is taken, so two daemons must never get neighbouring ports (the OS hands out consecutive ephemeral ports on Windows). The first port comes
// from the OS (bind to port 0), the others are drawn at random in the dynamic range until one is free and far enough from the previous ones.
// All servers are open at the same time while drawing, and closed before printing, so a daemon can bind the port right after.
import { createServer } from 'node:net';

const MIN_GAP = 32;
const RANGE_START = 49152;
const RANGE_END = 65000;
const MAX_DRAWS = 200;

const count = Number(process.argv[2]);
if (!Number.isInteger(count) || count < 1 || count > 16) {
  console.error(`freePorts.mjs: expected a count between 1 and 16 as the first argument, got ${JSON.stringify(process.argv[2])}`);
  process.exit(2);
}

function listen(port) {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

const servers = [await listen(0)];
const ports = [servers[0].address().port];
while (servers.length < count) {
  let found = false;
  for (let draw = 0; draw < MAX_DRAWS && !found; draw++) {
    const candidate = RANGE_START + Math.floor(Math.random() * (RANGE_END - RANGE_START));
    if (ports.some((port) => Math.abs(port - candidate) < MIN_GAP)) {
      continue;
    }
    try {
      servers.push(await listen(candidate));
      ports.push(candidate);
      found = true;
    } catch (err) {
      if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') {
        throw err;
      }
    }
  }
  if (!found) {
    console.error(`freePorts.mjs: no free port found after ${MAX_DRAWS} draws in ${RANGE_START}-${RANGE_END}`);
    process.exit(3);
  }
}
await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
console.log(ports.join('\n'));
