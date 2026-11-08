// Test helper (POSIX): listens on the unix socket path given as argument, says "ready", and waits to be killed. A kill -9 leaves the socket file behind, like a crashed wait.
import net from 'node:net';

const path = process.argv[2];
if (path === undefined) {
  process.stderr.write('usage: node wakeSocketOwner.testUtil.mjs <socket path>\n');
  process.exit(2);
}
const server = net.createServer();
server.listen(path, () => { process.stdout.write('ready\n'); });
// Keeps the process alive until it is killed
setInterval(() => undefined, 1000);
