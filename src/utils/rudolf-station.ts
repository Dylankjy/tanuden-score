import { OutputDataFrame, Station } from '@tanuden/rudolf';

// Shared "which station is next" resolution used both by the live-scoring
// segment-boundary detector (events/drive.event.ts) and every evaluator
// (evaluations/abstract-evaluation.ts) — kept in one place so the two can
// never drift out of sync with each other. A mismatch here could reintroduce
// frame pairs being split across the wrong segment boundary (see the
// trailing-overlap fix in utils/anticheat.ts).
export const resolveNextStationIndex = (
  frame: OutputDataFrame,
  stations: Station[]
): number => {
  if (frame.stations.nextIndex !== null) {
    return frame.stations.nextIndex;
  }
  if (frame.stations.currentIndex !== null) {
    return frame.stations.currentIndex;
  }
  return Math.max(stations.length - 1, 0);
};
