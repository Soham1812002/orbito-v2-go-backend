import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { frame } from './protocol.js';

export const ACK_TIMEOUT_MS = 15000;

export async function tracker(host: string, timeoutMs = ACK_TIMEOUT_MS) {
  const socket = createConnection({ host, port: 5002 });

  socket.setNoDelay(true);
  let buffer: Buffer = Buffer.alloc(0);
  let failure: Error | undefined;
  let wake: (() => void) | undefined;

  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    wake?.();
  });
  socket.on('error', (error) => {
    failure = error;
    wake?.();
  });
  socket.on('close', () => {
    failure ??= new Error('Tracker connection closed');
    wake?.();
  });
  const connected = once(socket, 'connect');
  const timer = setTimeout(() => socket.destroy(new Error('Connect timeout')), timeoutMs);

  try {
    await connected;
  } finally {
    clearTimeout(timer);
  }

  async function ack(type: number, serial: number, deadline = performance.now() + timeoutMs) {
    while (buffer.length < 10) {
      if (failure) {
        throw failure;
      }

      const remaining = deadline - performance.now();

      if (remaining <= 0) {
        throw new Error('Application ACK timeout');
      }

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);

        wake = () => {
          clearTimeout(timer);
          wake = undefined;
          resolve();
        };
      });
    }

    assert(performance.now() <= deadline, 'Application ACK exceeded its transmit deadline');
    const actual = buffer.subarray(0, 10);

    buffer = buffer.subarray(10);
    assert.deepEqual(
      actual,
      frame(type, serial, Buffer.alloc(0)),
      'Unexpected ACK type/serial/CRC (including forbidden ACK on a no-response type)',
    );
  }

  return {
    ack,
    write: (bytes: Buffer) =>
      new Promise<void>((resolve, reject) => {
        socket.write(bytes, (error) => (error ? reject(error) : resolve()));
      }),
    close: () => {
      socket.end();
    },
    destroy: () => {
      socket.destroy();
    },
  };
}
