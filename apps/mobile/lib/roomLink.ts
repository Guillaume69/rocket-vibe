/**
 * Room links were `rocketvibe://salon/<rid>` before the English rename: a
 * notification posted by an older build still carries that path.
 */
export function withEnglishRoomPath(path: string): string {
  return path.replace(/^((?:rocketvibe:)?\/*)salon\//, '$1room/');
}
