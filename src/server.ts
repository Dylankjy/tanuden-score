import express, { type Application } from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { routes } from './routes';
import { errorHandler } from './middleware/error-handler';
import mongoSanitizer from 'mongo-sanitizer';
import passport from './utils/passport';
import { driveEvents } from './events/drive.event';
import { authEvents } from './events/auth.event';

export const server = () => {
  const app: Application = express();

  app.use(morgan('combined'));

  app.disable('x-powered-by');
  app.use(helmet());

  app.use(express.json({ limit: '512kb' }));
  app.use(express.urlencoded({ extended: true, limit: '512kb' }));

  app.use(mongoSanitizer({ replaceWith: '_' }));

  app.set('trust proxy', 1);

  // Passport — initialize globally with a custom callback so that failure
  // (missing/invalid token) silently continues rather than sending a 401.
  // This populates req.user/req.authType for REST reads only (leaderboards,
  // stats, history) — fail-open like every other REST service in this
  // workspace. The live drive-submission socket verifies separately and
  // fail-closed; see middleware/socket-auth.ts.
  app.use(passport.initialize());
  app.use((req, res, next) => {
    passport.authenticate(
      'jwt',
      { session: false },
      (
        err: Error | null,
        user: (Express.User & { _authType?: 'session' | 'token' }) | false
      ) => {
        if (!err && user) {
          req.user = user;
          req.authType = user._authType ?? 'session';
        }
        next();
      }
    )(req, res, next);
  });

  routes(app);

  app.use(errorHandler);

  const httpServer = createServer(app);
  // CORS is handled entirely by tanuden-gateway, which validates allowed
  // origins and strips the Origin header before proxying. This service
  // performs no CORS checks of its own and must only ever be reached via the
  // gateway — same posture as tanuden-arisu.
  const io = new Server(httpServer);

  io.use((socket, next) => {
    if (typeof socket.data !== 'object') {
      return next(new Error('INVALID_SOCKET_DATA'));
    }
    next();
  });

  io.use((socket, next) => {
    socket.user = null;
    socket.driveRecordId = null;
    next();
  });

  io.on('connection', (socket) => {
    console.log(
      `New client connection - [${socket.id}] (${socket.handshake.address})`
    );

    // Disconnect if ack function is not provided — every event on this
    // socket is a request/response exchange, matching arisu's contract.
    socket.prependAny((_eventName, ...args) => {
      if (typeof args[args.length - 1] !== 'function') {
        return socket.disconnect(true);
      }
    });

    authEvents(io, socket);
    driveEvents(io, socket);

    socket.on('disconnect', () => {
      console.log(`Client disconnected - [${socket.id}]`);
    });
  });

  return { server: httpServer, io };
};
