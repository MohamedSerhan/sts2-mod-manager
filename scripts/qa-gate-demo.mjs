// Demo helper used to exercise the C+ QA-review loop end-to-end.
// (This file and its test are removed in a cleanup PR after the gate run.)

/** Clamp a percentage to the 0..100 range. */
export function clampPercent(n) {
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}
