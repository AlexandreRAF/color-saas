const { CapacityClient } = require('../../capacity_client');
const client = new CapacityClient(process.argv[2]);
let ticket;
client.acquire({ choices: [{ model: 'test' }], tokens: 10, runId: process.argv[3] }).then(value => {
  ticket = value;
  process.send({ granted: true });
}).catch(error => { process.send({ error: error.message }); });
process.on('message', async () => {
  ticket?.complete({ ok: true, status: 200, headers: new Headers() }, { usage: { input_tokens: 1, output_tokens: 1 } });
  setTimeout(() => { client.close(); process.disconnect(); }, 20);
});
