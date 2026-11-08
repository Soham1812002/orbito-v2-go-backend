export function utc(time: string | null) {
  return time
    ? new Date(time).toISOString().replace('T', ' ').replace(/Z$/, ' UTC')
    : 'Not provided';
}
