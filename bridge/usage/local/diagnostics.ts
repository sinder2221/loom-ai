export const skipReasons = [
  'oversizedLine', 'invalidUtf8', 'invalidJson', 'invalidRecord', 'invalidTimestamp', 'invalidUsage',
  'symlink', 'unreadableSource', 'changedSource', 'nonRegularSource',
] as const;

export type SkipReason = typeof skipReasons[number];
export type Skips = Record<SkipReason, number>;

export function newSkips(): Skips {
  return Object.fromEntries(skipReasons.map(reason => [reason, 0])) as Skips;
}
