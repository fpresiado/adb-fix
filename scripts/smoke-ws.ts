// Smoke test: connect to ADBPD WS on 3003, subscribe to events,
// trigger an event via the HTTP API, expect to receive it.

const ws = new WebSocket('ws://127.0.0.1:3003');
const received: unknown[] = [];

ws.onopen = (): void => {
  console.log('WS open');
  ws.send(JSON.stringify({ subscribe: ['device.*', 'maestro.*'] }));
};
ws.onmessage = (m): void => {
  const data = JSON.parse(String(m.data)) as Record<string, unknown>;
  console.log('WS recv:', JSON.stringify(data));
  received.push(data);
};
ws.onerror = (e): void => {
  console.error('WS error:', e);
};
ws.onclose = (): void => {
  console.log('WS closed');
};

await new Promise((r) => setTimeout(r, 1000));

// Trigger a maestro.started event via API.
const resp = await fetch('http://127.0.0.1:3002/maestro/run', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ serial: 'emulator-5554', flowFile: 'smoke.yaml' }),
});
console.log('maestro/run status:', resp.status, await resp.text());

await new Promise((r) => setTimeout(r, 2000));
ws.close();

const maestroEvents = received.filter((e) => (e as { event: string }).event === 'maestro.started');
console.log(`received ${received.length} events, ${maestroEvents.length} maestro.started`);
process.exit(maestroEvents.length > 0 ? 0 : 1);
