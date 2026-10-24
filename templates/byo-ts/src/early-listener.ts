import { createServer, type Socket } from "node:net";

export type EarlyListener = {
  /** Start passing connections, queued and future, to `inject`. */
  handoff: (inject: (socket: Socket) => void) => void;
};

/**
 * Opens the gRPC port at once, using only node:net, and holds each connection (paused,
 * unread) until the real server is ready. Substrate marks the actor ready when /readyz
 * answers and the router dials the gRPC port right away; a refused connection there
 * would fail the user's message while the heavy imports are still loading.
 */
export function startEarlyListener(addr: string): Promise<EarlyListener> {
  const cut = addr.lastIndexOf(":");
  const host = addr.slice(0, cut);
  const port = Number(addr.slice(cut + 1));
  let inject: ((socket: Socket) => void) | undefined;
  const queued: Socket[] = [];
  const server = createServer((socket) => {
    if (inject) {
      inject(socket);
      return;
    }
    socket.pause();
    queued.push(socket);
    socket.once("close", () => {
      const at = queued.indexOf(socket);
      if (at >= 0) queued.splice(at, 1);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () =>
      resolve({
        handoff(fn) {
          inject = fn;
          for (const socket of queued.splice(0)) {
            fn(socket);
            socket.resume();
          }
        },
      }),
    );
  });
}
