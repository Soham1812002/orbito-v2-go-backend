import type { Socket, io } from 'socket.io-client';

declare global {
  interface Window {
    io: typeof io;
  }
}

export interface LiveCallbacks {
  connected: () => void;
  disconnected: (unavailable: boolean) => void;
  log: (event: { deviceId: string }) => void;
  error: (error: unknown) => void;
}

export function liveConnection(ticket: () => Promise<string>, callbacks: LiveCallbacks) {
  let socket: Socket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let connecting = false;

  function schedule(delay: number) {
    if (disposed) {
      return;
    }

    if (timer) {
      clearTimeout(timer);
    }

    timer = setTimeout(() => {
      timer = undefined;
      void connect();
    }, delay);
  }

  async function connect() {
    if (disposed || connecting) {
      return;
    }

    connecting = true;
    socket?.removeAllListeners();
    socket?.close();
    try {
      const value = await ticket();

      if (disposed) {
        return;
      }

      socket = window.io({ autoConnect: false, reconnection: false, auth: { ticket: value } });
      socket.on('connect', callbacks.connected);
      socket.on('device:log', callbacks.log);
      socket.on('disconnect', () => {
        if (disposed) {
          return;
        }

        callbacks.disconnected(false);
        schedule(3000);
      });
      socket.on('connect_error', () => {
        if (disposed) {
          return;
        }

        callbacks.disconnected(true);
        socket?.close();
        schedule(5000);
      });
      socket.connect();
    } catch (error) {
      callbacks.error(error);
      schedule(5000);
    } finally {
      connecting = false;
    }
  }

  return {
    start: connect,
    dispose() {
      disposed = true;
      if (timer) {
        clearTimeout(timer);
      }

      socket?.removeAllListeners();
      socket?.close();
    },
  };
}
