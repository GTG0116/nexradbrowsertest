import assert from 'node:assert/strict';

class FakeWorker {
  static instances = [];
  static handler = null;

  constructor() {
    this.messages = [];
    this.terminated = false;
    FakeWorker.instances.push(this);
  }

  postMessage(message) {
    this.messages.push(message);
    if (this.throwOnPost) throw new Error('post failed');
    if (FakeWorker.handler) FakeWorker.handler(this, message);
  }

  terminate() {
    this.terminated = true;
  }

  reply(data) {
    queueMicrotask(() => this.onmessage({ data }));
  }
}

globalThis.Worker = FakeWorker;
const client = await import('../js/satClient.js');

{
  let attempts = 0;
  FakeWorker.handler = (worker, message) => {
    if (message.type !== 'ensure') return;
    attempts++;
    if (attempts === 1) worker.reply({ id: message.id, ok: false, error: 'temporary outage' });
    else worker.reply({ id: message.id, ok: true, channels: { 13: new Float32Array([250]) } });
  };
  const scene = { key: 'scene-a', channels: {} };
  const result = await client.ensureBandsAsync(scene, 'goes19', 'conus', [13, 13]);
  assert.equal(result, scene);
  assert.equal(attempts, 2, 'a failed band request should be retried once');
  assert.equal(scene.channels[13][0], 250);
}

{
  let attempts = 0;
  FakeWorker.handler = (worker, message) => {
    if (message.type !== 'ensure') return;
    attempts++;
    worker.reply({ id: message.id, ok: false, error: 'still unavailable' });
  };
  const scene = { key: 'scene-b', channels: {} };
  await assert.rejects(
    client.ensureBandsAsync(scene, 'goes19', 'conus', [2]),
    /band 2 unavailable after retry: still unavailable/
  );
  assert.equal(attempts, 2);
}

{
  const current = FakeWorker.instances.at(-1);
  current.throwOnPost = true;
  await assert.rejects(
    client.loadSceneAsync('goes19', 'conus', 'scene-c', [13]),
    /post failed/
  );
  assert.equal(current.terminated, true);
}

{
  FakeWorker.handler = () => {}; // leave one request pending, then crash the worker
  const request = client.loadSceneAsync('goes19', 'conus', 'scene-d', [13]);
  const current = FakeWorker.instances.at(-1);
  current.onerror({ message: 'boom' });
  await assert.rejects(request, /satellite worker error: boom/);
  assert.equal(current.terminated, true);

  FakeWorker.handler = (worker, message) => {
    worker.reply({ id: message.id, ok: true, scene: { key: message.key, channels: {} } });
  };
  const scene = await client.loadSceneAsync('goes19', 'conus', 'scene-e', [13]);
  assert.equal(scene.key, 'scene-e');
  assert.notEqual(FakeWorker.instances.at(-1), current, 'the next request should respawn the worker');
}

{
  const current = FakeWorker.instances.at(-1);
  current.throwOnPost = true;
  assert.doesNotThrow(() => client.clearSceneCache());
  assert.equal(current.terminated, true, 'a failed control message should retire the worker');
}

console.log('satClient tests passed');
