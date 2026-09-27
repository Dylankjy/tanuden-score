import { OutputDataFrame } from '@tanuden/rudolf';
import { round } from 'lodash';
import { LiveSession } from './live-sessions';
import {
  DOWNHILL_GRAVITY_ASSIST_GRADIENT_PERMILLE,
  FRAME_RATE_WINDOW_SIZE,
  MAX_DISTANCE_JUMP_M_PER_SEC,
  MAX_FRAME_RATE_HZ,
  MAX_NOTCH_STEPS_PER_SEC,
  MAX_REALISTIC_SPEED_KMH,
  MAX_SPEED_DELTA_KMH_PER_SEC,
  MIN_INCONSISTENT_ACCEL_KMH_PER_SEC
} from '../anti-cheat-constants';

export const checkPhysicsPlausibility = (
  previous: OutputDataFrame | null,
  current: OutputDataFrame
): string | null => {
  // Applies to every frame unconditionally, including the first (no previous
  // frame needed) — no real train on this network exceeds this speed in
  // either direction (reversing/shunting legitimately reports as negative).
  if (Math.abs(current.physics.speed) > MAX_REALISTIC_SPEED_KMH) {
    return `speed ${round(current.physics.speed, 1)} km/h exceeds the realistic maximum`;
  }

  if (!previous) {
    return null;
  }

  const elapsedSec = current.time.elapsed - previous.time.elapsed;
  if (elapsedSec <= 0) {
    // A live fast-plane stream should always tick forward — a client
    // shouldn't be emitting frames at all while paused/idle. Backward or
    // repeated elapsed time is treated as tampering, not a benign edge case.
    return `time.elapsed did not advance (${previous.time.elapsed} -> ${current.time.elapsed})`;
  }

  const speedDeltaPerSec =
    Math.abs(current.physics.speed - previous.physics.speed) / elapsedSec;
  if (speedDeltaPerSec > MAX_SPEED_DELTA_KMH_PER_SEC) {
    return `speed changed ${round(speedDeltaPerSec, 1)} km/h per second`;
  }

  const notchDeltaPerSec =
    (Math.abs(
      current.controllers.powerNotch - previous.controllers.powerNotch
    ) +
      Math.abs(
        current.controllers.brakeNotch - previous.controllers.brakeNotch
      )) /
    elapsedSec;
  if (notchDeltaPerSec > MAX_NOTCH_STEPS_PER_SEC) {
    return `notch changed ${round(notchDeltaPerSec, 1)} steps per second`;
  }

  const distanceDeltaPerSec =
    Math.abs(
      current.physics.fromStartDistance - previous.physics.fromStartDistance
    ) / elapsedSec;
  if (distanceDeltaPerSec > MAX_DISTANCE_JUMP_M_PER_SEC) {
    return `position jumped ${round(distanceDeltaPerSec, 1)} m per second`;
  }

  return null;
};

// Cross-signal correlation: do the reported controls actually explain the
// resulting speed change? Unlike the per-field deltas above, this needs both
// frames to be internally consistent with each other, which independently
// plausible-looking fabricated values wouldn't naturally satisfy. Coarse on
// purpose — there's no real per-vehicle traction/braking curve to check
// against, so this is one data point accumulated across the session
// (session.physicsInconsistencyCount), never a per-frame hard reject.
export const isPhysicsInconsistent = (
  previous: OutputDataFrame,
  current: OutputDataFrame
): boolean => {
  const elapsedSec = current.time.elapsed - previous.time.elapsed;
  if (elapsedSec <= 0) {
    return false;
  }

  const isCoastingOrBrakingOnly =
    current.controllers.powerNotch === 0 &&
    previous.controllers.powerNotch === 0;
  if (!isCoastingOrBrakingOnly) {
    return false;
  }

  const actualAccel =
    (current.physics.speed - previous.physics.speed) / elapsedSec;
  if (actualAccel < MIN_INCONSISTENT_ACCEL_KMH_PER_SEC) {
    return false;
  }

  // A steep-enough downhill grade can explain unpowered acceleration via
  // gravity alone — gradient is permille, positive = uphill (see
  // eco-drive.eval.ts's existing gradient handling), so a sufficiently
  // negative value is a real downhill.
  const gradient = current.physics.gradient ?? 0;
  if (gradient <= DOWNHILL_GRAVITY_ASSIST_GRADIENT_PERMILLE) {
    return false;
  }

  return true;
};

// Rolling-window frame-rate check — not a single-gap check, so a brief
// reconnect catch-up burst doesn't false-positive as long as the following
// frames return to normal cadence and dilute the window average. Mutates
// session.recentFrameArrivals as a side effect (tracks the rolling window).
export const checkFrameRateExceeded = (session: LiveSession): boolean => {
  const now = Date.now();
  session.recentFrameArrivals.push(now);
  if (session.recentFrameArrivals.length > FRAME_RATE_WINDOW_SIZE) {
    session.recentFrameArrivals.shift();
  }

  if (session.recentFrameArrivals.length < FRAME_RATE_WINDOW_SIZE) {
    return false;
  }

  const oldest = session.recentFrameArrivals[0]!;
  const windowSec = (now - oldest) / 1000;
  if (windowSec <= 0) {
    return true;
  }

  const rateHz = (FRAME_RATE_WINDOW_SIZE - 1) / windowSec;
  return rateHz > MAX_FRAME_RATE_HZ;
};
