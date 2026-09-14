import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { EventHub } from '../server/core/events.mjs';

function responseDouble({ writeResult = true, throwOnEvent = false } = {}) {
  const response = new EventEmitter();
  response.destroyed = false;
  response.writableEnded = false;
  response.writes = [];
  response.ended = false;
  response.writeHead = () => {};
  response.write = (value) => {
    if (throwOnEvent && String(value).startsWith('event:')) throw new Error('socket failed');
    response.writes.push(String(value));
    return writeResult;
  };
  response.end = () => { response.ended = true; response.writableEnded = true; };
  response.destroy = () => { response.destroyed = true; };
  return response;
}

test('SSE publishes events and removes clients on close', () => {
  const hub = new EventHub();
  const response = responseDouble();
  hub.subscribe(response);
  assert.equal(hub.clientCount, 1);
  hub.publish('task.updated', { id: 't1' });
  assert.ok(response.writes.some((value) => value.includes('event: task.updated')));
  response.emit('close');
  assert.equal(hub.clientCount, 0);
});

test('SSE drops a backpressured client instead of growing an unbounded buffer', () => {
  const hub = new EventHub();
  const response = responseDouble({ writeResult: false });
  hub.subscribe(response);
  assert.equal(hub.clientCount, 0);
  assert.equal(response.ended, true);
});

test('one broken SSE client cannot make control-plane publication throw', () => {
  const hub = new EventHub();
  const response = responseDouble({ throwOnEvent: true });
  hub.subscribe(response);
  assert.doesNotThrow(() => hub.publish('run.updated', { id: 'r1' }));
  assert.equal(hub.clientCount, 0);
  assert.equal(response.destroyed, true);
});
