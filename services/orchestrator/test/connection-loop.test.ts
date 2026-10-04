import { afterEach, expect, it, vi } from 'vitest';
import { ConnectionLoop } from '../src/connection-loop.js';
afterEach(() => vi.useRealTimers());

it('recovers across repeated failures and exposes readiness only after preparation', async () => {
  vi.useFakeTimers();
  const prepare = vi.fn(async () => {});
  const process = vi.fn(async () => {});
  let disconnect = () => {};
  const connect = vi.fn(async (_signal: AbortSignal, callback: () => void) => {
    disconnect = callback;
    if (connect.mock.calls.length < 3) throw new Error('offline');
    return {id:connect.mock.calls.length};
  });
  const loop = new ConnectionLoop({connect, prepare, process, dispose:vi.fn()});
  loop.start();
  expect(loop.ready).toBeNull();
  await vi.advanceTimersByTimeAsync(1500);
  expect(connect).toHaveBeenCalledTimes(3);
  expect(loop.ready).toEqual({id:3});
  expect(prepare).toHaveBeenCalledTimes(1);
  disconnect(); expect(loop.ready).toBeNull();
  await vi.advanceTimersByTimeAsync(500);
  expect(loop.ready).toEqual({id:4});
  expect(vi.getTimerCount()).toBe(1);
  loop.stop(); expect(vi.getTimerCount()).toBe(0);
});

it('does not report a connected but unauthorized or unsubscribed worker as ready', async () => {
  vi.useFakeTimers();
  const process=vi.fn(async()=>{}), dispose=vi.fn();
  const loop=new ConnectionLoop({connect:async()=>({id:1}), prepare:async()=>{throw new Error('unauthorized');}, process, dispose});
  loop.start(); await vi.advanceTimersByTimeAsync(1);
  expect(loop.ready).toBeNull(); expect(process).not.toHaveBeenCalled(); expect(dispose).toHaveBeenCalled();
  loop.stop(); await vi.advanceTimersByTimeAsync(10000);
  expect(vi.getTimerCount()).toBe(0);
});

it('ignores stale disconnections and never runs concurrent ticks', async () => {
  vi.useFakeTimers();
  const disconnects: (()=>void)[]=[];
  let release=()=>{};
  let active=0, maximum=0;
  const process=vi.fn(async()=>{active++; maximum=Math.max(maximum,active);
    await new Promise<void>(resolve=>{release=resolve;}); active--;});
  const loop=new ConnectionLoop({connect:async(_s,cb)=>{disconnects.push(cb);return {id:disconnects.length};},
    prepare:async()=>{}, process,dispose:vi.fn()});
  loop.start(); await vi.advanceTimersByTimeAsync(1);
  disconnects[0](); await vi.advanceTimersByTimeAsync(500);
  disconnects[0](); expect(loop.ready).toEqual({id:2});
  release(); await vi.advanceTimersByTimeAsync(1);
  expect(maximum).toBe(1); expect(process).toHaveBeenCalledTimes(2);
  release(); loop.stop();
});
