export const DEFAULT_AUTO_LOCK_MINUTES = 15;
export const MIN_AUTO_LOCK_MINUTES = 1;
export const MAX_AUTO_LOCK_MINUTES = 1440;

export function validAutoLockMinutes(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
    && value >= MIN_AUTO_LOCK_MINUTES && value <= MAX_AUTO_LOCK_MINUTES;
}
