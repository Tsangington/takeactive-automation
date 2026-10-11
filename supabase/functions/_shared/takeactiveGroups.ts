export type TakeActiveGroup = {
  master: string;
  slug: string;
};

export const TAKEACTIVE_GROUPS: TakeActiveGroup[] = [
  { master: "BADMINTON-TREPTOW", slug: "badminton-treptow" },
  { master: "VFB-KIEFHOLZ-LEAGUE-TEAM", slug: "vfb-kiefholz-league-team" },
];

export function groupForMaster(masterCompanyId: string): TakeActiveGroup | undefined {
  return TAKEACTIVE_GROUPS.find((g) => g.master === masterCompanyId);
}

export function historyUrl(group: TakeActiveGroup, page: number): string {
  return `https://api.takeactive.com/api/${group.master}/stats/appointmenthistory/${group.slug}/history?page=${page}`;
}

export function appointmentDetailUrl(group: TakeActiveGroup, appointmentId: string): string {
  return `https://api.takeactive.com/api/${group.master}/appointment/${group.slug}/${appointmentId}`;
}

export function appointmentListUrl(group: TakeActiveGroup): string {
  return `https://api.takeactive.com/api/${group.master}/appointment/${group.slug}`;
}

export function acceptUrl(master: string, appointmentId: string): string {
  return `https://api.takeactive.com/api/${master}/appointment/accept/${appointmentId}`;
}

export function cancelUrl(master: string, appointmentId: string): string {
  return `https://api.takeactive.com/api/${master}/appointment/cancel/${appointmentId}`;
}

function intOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Columns persisted from a TakeActive appointment payload. */
export function bookableColumns(appointment: {
  bookable_from?: unknown;
  bookable_till?: unknown;
  bookable_from_date?: unknown;
}): {
  bookable_from: number | null;
  bookable_till: number | null;
  bookable_from_at: string | null;
} {
  const raw = appointment.bookable_from_date == null
    ? ""
    : String(appointment.bookable_from_date).trim().replace(" ", "T");
  return {
    bookable_from: intOrNull(appointment.bookable_from),
    bookable_till: intOrNull(appointment.bookable_till),
    bookable_from_at: raw ? raw.slice(0, 19) : null,
  };
}

/** Naive `YYYY-MM-DDTHH:mm:ss` Europe/Berlin wall time → UTC epoch ms. */
export function berlinNaiveToMs(naive: string): number {
  const trimmed = naive.trim().replace(" ", "T").slice(0, 19);
  const utcGuess = Date.parse(`${trimmed}Z`);
  if (!Number.isFinite(utcGuess)) throw new Error(`Invalid Berlin timestamp: ${naive}`);
  const wall = new Date(utcGuess)
    .toLocaleString("sv-SE", { timeZone: "Europe/Berlin" })
    .replace(" ", "T")
    .slice(0, 19);
  const offset = Date.parse(`${wall}Z`) - utcGuess;
  return utcGuess - offset;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const TAKEACTIVE_DELAY_MS = 3000;

export function berlinToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Berlin" });
}

export function parseDateRange(
  body: { from?: string; to?: string } | null,
  defaults: { from: string; to: string }
): { from: string; to: string } {
  return {
    from: body?.from ?? defaults.from,
    to: body?.to ?? defaults.to,
  };
}
