import { Server, Socket } from 'socket.io';
import { isAuthenticated } from '../middleware/socket-auth';
import { crashPrevent, errorResponseData } from '../utils/socket-error-handler';

// Mirrors tanuden-arisu's auth:login exactly, for the same reason: the
// gateway-minted JWT in socket.handshake.headers is only valid 30s and is
// fixed for the life of the connection, but a drive session can legitimately
// start hours after the socket first connects. Authenticating here, right
// after connect, stamps socket.user while the JWT is still fresh; every
// drive:* event's ensureAuthenticated then short-circuits on the already-
// stamped socket.user for the rest of the connection's lifetime instead of
// re-verifying a JWT that would long since have expired.
export const authEvents = (_io: Server, socket: Socket) => {
  socket.on(
    'auth:login',
    crashPrevent(async (_data: null, ack: (res: unknown) => void) => {
      try {
        await isAuthenticated(socket);
      } catch (err) {
        return ack(
          errorResponseData(
            'AUTHENTICATION_ERROR',
            err instanceof Error ? err.message : undefined
          )
        );
      }

      ack({ ok: true });
    })
  );
};
