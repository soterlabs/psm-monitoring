// Kept self-contained so the dashboard can embed this same function in its script.
export function reserveChartAxis(min: number, max: number): { lo: number; hi: number; ticks: number[] } {
  const minStep = max >= 1e9 ? 1e8 : 10 ** (Math.floor(Math.log10(Math.max(max, 1))) - 1);
  const span = Math.max(max - min, minStep * 2);
  const lower = Math.max(0, min - span * .1), upper = max + span * .1;
  const roughStep = Math.max((upper - lower) / 5, minStep);
  const power = 10 ** Math.floor(Math.log10(roughStep)), fraction = roughStep / power;
  const step = (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * power;
  const lo = Math.floor(lower / step) * step, hi = Math.ceil(upper / step) * step;
  const ticks: number[] = [];
  for (let index = 0; index <= Math.round((hi - lo) / step); index++) ticks.push(lo + index * step);
  return { lo, hi, ticks };
}
