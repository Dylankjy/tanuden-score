import { User } from './user';

export interface ClientMetadata {
  // Set once the gateway JWT has been verified AND its _authType is 'token'
  // (desktop-pairing-derived). A browser-session-derived JWT never populates
  // this — sessions can read REST leaderboards/stats, but cannot open a
  // scoring socket. See middleware/socket-auth.ts.
  user: User | null;
  // The drive_record this socket is currently bound to (set by drive:profile
  // or drive:resume). LiveSessions are keyed by record ID, not socket.id, so
  // this is how the disconnect handler finds which session to start the
  // reconnect-grace timer on.
  driveRecordId: string | null;
}
