import { clampPercent } from './qa-gate-demo.mjs';

// Lower-bound
console.assert(clampPercent(-1) === 0, 'negative clamps to 0');
console.assert(clampPercent(-100) === 0, 'large negative clamps to 0');
console.assert(clampPercent(0) === 0, 'zero is preserved');

// In-range
console.assert(clampPercent(50) === 50, 'mid-range passes through');
console.assert(clampPercent(100) === 100, '100 is preserved');

// Upper-bound
console.assert(clampPercent(101) === 100, 'just-over clamps to 100');
console.assert(clampPercent(150) === 100, 'large over-bound clamps to 100');

console.log('qa-gate-demo tests passed');
