// Tuned against the full dataset/ sample set: -a/-b/-c (3 drives, ~15.7k
// frames) plus -full (183 drives, ~785k frames — 801k frames total). The
// larger sample shifted several maxima meaningfully past what the 3-drive
// pass found, which is exactly why these stayed a single named-constant edit
// point rather than being inlined: observed max speed-delta 8.29 km/h/s, max
// notch-delta 53.06 steps/s, max distance-delta 76.91 m/s, max |speed| 112.15
// km/h, 0.10% of frames have negative speed (reversing/shunting — legitimate,
// not an error). Revisit again as more sample drives arrive; even 801k
// frames across 183 runs is a sample, not a guarantee.

// Hard physical ceiling — no real train on this network exceeds this speed in
// either direction (reversing shows as negative speed in the sample data, so
// this compares the magnitude). Applies unconditionally to every frame,
// including the very first, before there's a previous frame to diff against.
export const MAX_REALISTIC_SPEED_KMH = 115;

// ~1.8x the observed max (8.29) — well above real service/emergency braking,
// but still catches an instant 0-to-full-speed jump (which implies hundreds
// of km/h/s).
export const MAX_SPEED_DELTA_KMH_PER_SEC = 15;
// ~1.5x the observed max (53.06). This value has grown with every larger
// sample so far (20.8 -> 30.65 -> 53.06) rather than converging, so treat it
// as still under-characterized — don't tighten this without a much larger
// or more diverse sample than what's currently in dataset/.
export const MAX_NOTCH_STEPS_PER_SEC = 80;
// ~1.3x the observed max (76.91). A dedicated mismatch check (does distance
// moved match what the reported speed implies, not just a flat rate cap)
// found this kind of large jump in 35 of 606k moving-frame transitions
// (0.006%) spread across 15 of 183 records — rare and spread across many
// different runs, not concentrated in one bad recording, so treated as an
// intermittent recording/engine quirk (e.g. a frame skip or reset) rather
// than a data-quality problem with the distance field itself. Widened past
// it rather than rejecting it — the speed cap and speed-delta check above
// still catch actual impossible movement while in motion.
export const MAX_DISTANCE_JUMP_M_PER_SEC = 100;

// Persistence flush cadence — decoupled from the console's ~100ms fast-plane
// send rate on purpose (see Phase C plan).
export const FRAME_FLUSH_INTERVAL_MS = 5000;

// Trailing overlap kept across a live-scoring segment reset so departure
// detection (which needs a "stopped" and a "departing" frame in the same
// buffer) can never be severed by the reset itself. Same provisional-constant
// caveat as the physics thresholds above — validate against real station
// dwell-time distributions before trusting this in production.
export const SEGMENT_OVERLAP_WINDOW_MS = 5000;

// Reconnect grace window: a disconnected session may drive:resume within this
// window without penalty; past it, the run is finalized as 'timed-out'.
export const RECONNECT_GRACE_MS = 5 * 60 * 1000;

// Cold-start floor for the statistical-outlier check — mirrors
// rankings.controller.ts's totalRecords >= 5 leaderboard-eligibility gate.
export const OUTLIER_MIN_RECORDS = 5;
export const OUTLIER_Z_SCORE_THRESHOLD = 3;

// -- Anti-cheat expansion ---------------------------------------------------
// Unlike the physics thresholds above, these are not yet validated against
// the sample dataset — there's legitimate-play data to check false-positive
// rate against, but no known-cheating examples to check detection rate
// against. Treat as provisional guesses, same single-edit-point discipline.

// Cross-signal physics correlation (soft/cumulative, see finalizeSession).
// Below this magnitude, "unexplained" acceleration is within normal noise
// (rolling resistance variance, sensor jitter) and not worth counting.
export const MIN_INCONSISTENT_ACCEL_KMH_PER_SEC = 1.5;
// Gradient (permille, positive = uphill) below which a downhill coast can
// plausibly explain acceleration with no power applied — a realistic steep
// grade cutoff, not the steepest theoretically possible grade.
export const DOWNHILL_GRAVITY_ASSIST_GRADIENT_PERMILLE = -15;
// Fraction of a session's frames that can be "inconsistent" (per above)
// before the whole run gets soft-flagged. A coarse heuristic without real
// per-vehicle traction curves needs a generous floor to avoid false
// positives from legitimate edge cases the model doesn't capture.
export const MAX_PHYSICS_INCONSISTENCY_RATIO = 0.02;

// Clock/timing integrity. Ratio of claimed-simulated-duration to observed
// real-wall-clock-duration for the whole session; > 1 means the sim clock
// ran faster than real time. 1.3 is a generous margin over normal
// network/processing jitter accumulated over a whole drive.
export const MAX_CLOCK_DRIFT_RATIO = 1.3;

// Frame-rate abuse. Rolling-window average, not a single-gap check, so a
// brief reconnect catch-up burst doesn't false-positive as long as the
// following frames return to normal cadence. 20Hz is 2x the ~10Hz fast-plane
// target cadence (see Phase C plan).
export const FRAME_RATE_WINDOW_SIZE = 20;
export const MAX_FRAME_RATE_HZ = 20;
