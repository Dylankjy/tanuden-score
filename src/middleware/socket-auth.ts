import { Socket } from 'socket.io';
import { User } from '../types/user';
import jwt from 'jsonwebtoken';
import { WEBSERVER } from '../constants';

// Verifies the gateway JWT the same way as every other service (ES512,
// iss: tanuden-gateway, aud: tanuden-services) — but unlike a plain reads-only
// socket, this gates score submission, so it additionally refuses any token
// whose _authType isn't 'token'. _authType: 'session' means the JWT was minted
// from a browser cookie session; _authType: 'token' means it was minted from a
// validated desktop pairing token. Only the latter may open a scoring socket —
// this is what stops the console from injecting its own trust directly into
// the socket instead of going through the gateway's proxied auth.
export const isAuthenticated = async (socket: Socket) => {
  const authHeader = socket.handshake.headers.authorization;

  let tokenData;
  try {
    tokenData = jwt.verify(
      authHeader?.split(' ')[1] as string,
      WEBSERVER.JWT_PUBLIC_KEY,
      {
        algorithms: ['ES512'],
        issuer: WEBSERVER.JWT_ISSUER,
        audience: WEBSERVER.JWT_AUDIENCE,
        complete: true
      }
    );
  } catch (err) {
    console.log(err);
    throw new Error('Invalid or Expired JWT');
  }

  const payload = tokenData.payload as User & {
    _authType?: 'session' | 'token';
  };
  if (!payload) {
    throw new Error('User not found in payload');
  }
  if (payload._authType !== 'token') {
    throw new Error('Only desktop client tokens may open a scoring session');
  }

  socket.user = payload;
};
