import { round } from 'lodash';
import { Evaluation } from './abstract-evaluation';
import { stdev } from 'stats-lite';

// Station arrival/departure and the frame's own time.sim are both the sim's
// in-universe schedule clock ("HH:MM:SS" — see Rudolf's Time.sim doc comment
// for the dateKnown:false case every current adapter uses), which is a
// different clock entirely from frame.sentAt (the real wall-clock time the
// packet was transmitted). Diffing sentAt against a station's schedule
// string is comparing two unrelated clocks — new Date("HH:MM:SS") is an
// Invalid Date, so every diff silently became NaN. Falls back to parsing an
// ISO datetime's time-of-day component if dateKnown is ever true.
const timeOfDayToSeconds = (value: string): number => {
  const timePart = value.includes('T')
    ? new Date(value).toISOString().slice(11, 19)
    : value;
  const [hours, minutes, seconds] = timePart.split(':').map(Number);
  return (hours ?? 0) * 3600 + (minutes ?? 0) * 60 + (seconds ?? 0);
};

export class TimelinessEvaluation extends Evaluation {
  timelinessAllowance = 2; // seconds
  timelinessRange = 20 - this.timelinessAllowance; // seconds -- Includes allowance
  xpMaxTimeliness = 600;
  xpMaxTimelinessPenalty = -300;
  xpMaxTimelinessConsistency = 300;
  xpMinuteEarlyDeparture = -500;

  evaluatePost() {
    // Check if the first station is Enohara-shako if passing. If it is, remove timeliness scoring for Enohara.
    // Enohara has an impossible departure time provided by the game.
    if (
      this.stations[0]?.name === '江ノ原車庫' &&
      this.stations[1]?.name === '江ノ原' &&
      this.stations[1]?.stopType === 'Passing'
    ) {
      this.scoreBreakdown = this.scoreBreakdown.filter(
        (breakdown) =>
          !(
            breakdown.stationIndex === 1 &&
            breakdown.reason === 'timeliness-passing'
          )
      );
    }
  }

  evaluate() {
    const arrivalRecords = this.arrivalRecords().uniqueSkipFirst;
    const departRecords = this.departRecords().uniqueSkipLast;
    const passRecords = this.passingRecords().unique;

    const arrivalTimeDiffs = arrivalRecords.map((frame) => {
      const stationIndex = this.nextStationIndex(frame);
      const arrivalTime = this.stations[stationIndex]?.arrival;
      const diff = arrivalTime
        ? timeOfDayToSeconds(frame.time.sim) - timeOfDayToSeconds(arrivalTime)
        : 0;

      return { frame, stationIndex, diff };
    });

    const departureTimeDiffs = departRecords.map((frame) => {
      const stationIndex = this.nextStationIndex(frame);
      const departureTime = this.stations[stationIndex - 1]?.departure;
      const diff = departureTime
        ? timeOfDayToSeconds(frame.time.sim) - timeOfDayToSeconds(departureTime)
        : 0;

      return { frame, stationIndex, diff };
    });

    passRecords.forEach((frame) => {
      const stationIndex = this.nextStationIndex(frame);
      const stationDepartureTime = this.stations[stationIndex]?.departure;

      const timeDiff = stationDepartureTime
        ? timeOfDayToSeconds(frame.time.sim) -
          timeOfDayToSeconds(stationDepartureTime)
        : 0;
      let interpretedTime = Math.abs(timeDiff);

      // If difference is smaller than the allowance, set to 0
      if (interpretedTime <= this.timelinessAllowance) {
        interpretedTime = 0;
      } else {
        interpretedTime = Math.abs(interpretedTime - this.timelinessAllowance);
      }

      let scorePassing =
        ((this.timelinessRange - interpretedTime) / this.timelinessRange) *
        this.xpMaxTimeliness;

      if (scorePassing <= this.xpMaxTimelinessPenalty) {
        scorePassing = this.xpMaxTimelinessPenalty;
      }

      this.scoreBreakdown.push({
        timeframe: new Date(frame.sentAt),
        stationIndex,
        reason: 'timeliness-passing',
        data: [round(timeDiff, 2), this.stations[stationIndex]?.name ?? ''],
        score: scorePassing,
        maxPossibleScore: this.xpMaxTimeliness,
        type: scorePassing > 0 ? 'Good' : 'Bad'
      });
    });

    arrivalTimeDiffs.forEach(({ frame, stationIndex, diff }) => {
      const timeDiff = diff;
      let interpretedTime = Math.abs(timeDiff);

      if (interpretedTime <= this.timelinessAllowance) {
        interpretedTime = 0;
      } else {
        interpretedTime = Math.abs(interpretedTime - this.timelinessAllowance);
      }

      let scoreArrivalTime =
        ((this.timelinessRange - interpretedTime) / this.timelinessRange) *
        this.xpMaxTimeliness;

      if (scoreArrivalTime <= this.xpMaxTimelinessPenalty) {
        scoreArrivalTime = this.xpMaxTimelinessPenalty;
      }

      this.scoreBreakdown.push({
        timeframe: new Date(frame.sentAt),
        stationIndex,
        reason: 'timeliness-arrival',
        data: [round(timeDiff, 2)],
        score: scoreArrivalTime,
        maxPossibleScore: this.xpMaxTimeliness,
        type: scoreArrivalTime > 0 ? 'Good' : 'Bad'
      });
    });

    departureTimeDiffs.forEach(({ frame, stationIndex, diff }) => {
      const timeDiff = diff;
      let interpretedTime = Math.abs(timeDiff);

      // If difference is smaller than the allowance, set to 0
      if (interpretedTime <= this.timelinessAllowance) {
        interpretedTime = 0;
      } else {
        interpretedTime = Math.abs(interpretedTime - this.timelinessAllowance);
      }

      // NOTE (carried over from myuntendai, unverified): this reads the
      // previous station's `arrival` despite representing its departure —
      // ported as-is since changing it would change scoring behavior; flag
      // for a domain-owner check rather than a silent fix.
      const stoppedStationDepartureTime =
        this.stations[stationIndex - 1]?.arrival;

      // If the departure time minutes is 00, and the departure is early, penalize it
      const stoppedStationDepartureSeconds = stoppedStationDepartureTime
        ? timeOfDayToSeconds(stoppedStationDepartureTime)
        : null;
      if (
        stoppedStationDepartureSeconds !== null &&
        Math.floor(stoppedStationDepartureSeconds / 60) % 60 === 0 &&
        stoppedStationDepartureSeconds % 60 === 0 &&
        diff < 0
      ) {
        this.scoreBreakdown.push({
          timeframe: new Date(frame.sentAt),
          stationIndex,
          reason: 'timeliness-departure-minute-early',
          data: [round(timeDiff, 2)],
          score: this.xpMinuteEarlyDeparture,
          maxPossibleScore: this.xpMaxTimeliness,
          type: 'VeryBad'
        });
        return;
      }

      let scoreDepartureTime =
        ((this.timelinessRange - interpretedTime) / this.timelinessRange) *
        this.xpMaxTimeliness;

      if (scoreDepartureTime <= this.xpMaxTimelinessPenalty) {
        scoreDepartureTime = this.xpMaxTimelinessPenalty;
      }

      this.scoreBreakdown.push({
        timeframe: new Date(frame.sentAt),
        stationIndex,
        reason: 'timeliness-departure',
        data: [round(timeDiff, 2)],
        score: scoreDepartureTime,
        maxPossibleScore: this.xpMaxTimeliness,
        type: scoreDepartureTime > 0 ? 'Good' : 'Bad'
      });
    });

    // Calculate consistency bonuses. Bug fix: stdev() needs at least 2
    // samples — the old guard only checked station count, not the diffs
    // array length, so short/edge-case runs (e.g. one arrival, zero
    // departures) could pass a 0- or 1-length array into stdev() and produce
    // NaN consistency scores.
    if (arrivalTimeDiffs.length >= 2) {
      const stdevArrivalTimeliness = stdev(
        arrivalTimeDiffs.map((data) => data.diff)
      );

      const scoreArrivalConsistency = round(
        this.xpMaxTimelinessConsistency /
          (stdevArrivalTimeliness / 2 < 1 ? 1 : stdevArrivalTimeliness / 2),
        1
      );

      this.scoreBreakdown.push({
        reason: 'consistency-arrival',
        data: [],
        score: scoreArrivalConsistency,
        maxPossibleScore: this.xpMaxTimelinessConsistency,
        type: 'Bonus'
      });
    }

    if (departureTimeDiffs.length >= 2) {
      const stdevDepartureTimeliness = stdev(
        departureTimeDiffs.map((data) => data.diff)
      );

      const scoreDepartureConsistency = round(
        this.xpMaxTimelinessConsistency /
          (stdevDepartureTimeliness / 2 < 1 ? 1 : stdevDepartureTimeliness / 2),
        1
      );
      this.scoreBreakdown.push({
        reason: 'consistency-departure',
        data: [],
        score: scoreDepartureConsistency,
        maxPossibleScore: this.xpMaxTimelinessConsistency,
        type: 'Bonus'
      });
    }

    // A drive with no recorded arrivals/departures (e.g. cancelled/completed
    // before reaching a stop) would otherwise divide by zero and produce NaN,
    // which Mongoose's Number schema rejects outright at save time.
    const averageArrivalTimeliness =
      arrivalTimeDiffs.length === 0
        ? 0
        : round(
            arrivalTimeDiffs.reduce(
              (acc, data) => acc + Math.abs(data.diff),
              0
            ) / arrivalTimeDiffs.length,
            2
          );

    const averageDepartureTimeliness =
      departureTimeDiffs.length === 0
        ? 0
        : round(
            departureTimeDiffs.reduce(
              (acc, data) => acc + Math.abs(data.diff),
              0
            ) / departureTimeDiffs.length,
            2
          );

    this.evaluatePost();

    return {
      additionalData: {
        averageTimeliness: round(
          averageArrivalTimeliness + averageDepartureTimeliness / 2,
          3
        )
      },
      scoreBreakdown: this.scoreBreakdown
    };
  }
}
