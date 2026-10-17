export function parseLimit(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 20;
}
