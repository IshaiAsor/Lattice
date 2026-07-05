/**
 * TCP relay: exposes EMQX port 8883 (Docker, loopback-only) on the LAN interface.
 * Run with: node scripts/mqtt-relay.js
 * Required because Docker Desktop WSL2 only binds ports to 127.0.0.1, not the LAN NIC.
 * Plain TCP forwarding — does not touch TLS bytes; ESP32 ↔ EMQX TLS handshake is end-to-end.
 */
const net = require('net');

const LISTEN_HOST = process.env.RELAY_LISTEN_HOST || '0.0.0.0';
const LISTEN_PORT = parseInt(process.env.RELAY_LISTEN_PORT || '8883');
const TARGET_HOST = process.env.RELAY_TARGET_HOST || '127.0.0.1';
const TARGET_PORT = parseInt(process.env.RELAY_TARGET_PORT || '8883');

const server = net.createServer((client) => {
  const remote = `${client.remoteAddress}:${client.remotePort}`;
  const target = net.createConnection({ host: TARGET_HOST, port: TARGET_PORT });

  client.pipe(target);
  target.pipe(client);

  const cleanup = () => {
    client.destroy();
    target.destroy();
  };
  client.on('error', cleanup);
  target.on('error', cleanup);
  client.on('close', cleanup);
  target.on('close', cleanup);

  target.on('connect', () => console.log(`[relay] ${remote} → ${TARGET_HOST}:${TARGET_PORT}`));
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`[relay] Listening on ${LISTEN_HOST}:${LISTEN_PORT} → ${TARGET_HOST}:${TARGET_PORT}`);
});

server.on('error', (err) => {
  console.error('[relay] Error:', err.message);
  process.exit(1);
});
