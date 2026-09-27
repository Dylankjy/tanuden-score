import passport from 'passport';
import { Strategy as JwtStrategy, ExtractJwt } from 'passport-jwt';
import { WEBSERVER } from '../constants';
import { User } from '../types/user';

const opts = {
  jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
  secretOrKey: WEBSERVER.JWT_PUBLIC_KEY,
  issuer: WEBSERVER.JWT_ISSUER,
  audience: WEBSERVER.JWT_AUDIENCE,
  algorithms: ['ES512' as const]
};

// Verifies the short-lived gateway JWT and passes the decoded payload to
// done(). Used only for REST reads (leaderboards/stats/history) — the live
// drive-submission socket uses its own lazy verification, see
// middleware/socket-auth.ts.
passport.use(
  new JwtStrategy(opts, (jwt_payload, done) => {
    if (jwt_payload) {
      return done(
        null,
        jwt_payload as User & { _authType: 'session' | 'token' }
      );
    }
    return done(null, false);
  })
);

export default passport;
