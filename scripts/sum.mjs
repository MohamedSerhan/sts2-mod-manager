/**
 * Returns the sum of an array of numbers.
 * Non-number entries are ignored. Empty or missing array returns 0.
 * @param {unknown[]} numbers
 * @returns {number}
 */
export function sum(numbers) {
  if (!Array.isArray(numbers)) return 0;
  return numbers.reduce((acc, val) => (typeof val === 'number' ? acc + val : acc), 0);
}
