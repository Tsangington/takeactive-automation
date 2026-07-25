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
