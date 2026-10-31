// Smoke test: two Relay agents DM each other; a listener in this process and an
// observer in another process report what they see.
import { AgentRelay } from '@agent-relay/sdk';

const relay = new AgentRelay({ workspaceKey: process.env.RELAY_WORKSPACE_KEY!, baseUrl: process.env.RELAY_BASE_URL });
const mode = process.argv[2];
if (mode === 'observer') {
  await relay.workspace.register({ name: 'observer-' + Date.now(), type: 'agent' });
  relay.addListener('*', (e: any) => console.log('OBSERVER EVENT', e.type, JSON.stringify(e).slice(0, 300)));
  setTimeout(() => process.exit(0), 10000);
} else {
  const pm = await relay.workspace.register({ name: 'smoke-pm-' + Date.now(), type: 'agent' });
  await relay.workspace.register({ name: 'smoke-eng-' + process.pid, type: 'agent' });
  relay.addListener('*', async (e: any) => { console.log('EVT', e.type);
    console.log('LISTENER', JSON.stringify({ envelope: e.envelope, text: e.message?.text }).slice(0, 600));
  });
  console.log('KEYS', Object.keys(pm), typeof (pm as any).token); await new Promise(r => setTimeout(r, 2500));
  const r = await pm.sendMessage({ to: '@smoke-eng-' + process.pid, text: 'hello engineer, here is a spec' });
  console.log('sent', JSON.stringify(r).slice(0, 300));
  await new Promise(r => setTimeout(r, 4000));
  process.exit(0);
}
