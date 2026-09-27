import { User as UserType } from './user';
import { ClientMetadata } from './client-metadata';

declare global {
  namespace Express {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface User extends UserType {}
    interface Request {
      authType?: 'token' | 'session';
      user?: UserType;
    }
  }
}

declare module 'socket.io' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Socket extends ClientMetadata {}
}
