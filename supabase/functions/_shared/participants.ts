/** Keep in sync with scripts/lib/participants.mjs */

export type ParticipantType = "member" | "guest" | "deleted";

export type ClassifiedParticipant = {
  external_id: number;
  participant_type: ParticipantType;
  member_id: string | null;
  guest_username: string | null;
  member_name: string | null;
  booked_at: string | null;
  canceled_at: string | null;
  is_cancelled: boolean;
};

export function classifyParticipant(p: any): ClassifiedParticipant | null {
  const externalRaw = p?.id;
  const external_id = Number(externalRaw);
  if (!Number.isFinite(external_id)) return null;

  const userId = p?.user_id ?? p?.user?.id ?? null;
  const memberId = userId != null && String(userId) !== "" ? String(userId) : null;
  const apiType = String(p?.type ?? "").toUpperCase();
  const isCancelled = !!p?.canceled_at && p.canceled_at !== "";

  if (apiType === "GUEST" || (!memberId && p?.guest_username)) {
    return {
      external_id,
      participant_type: "guest",
      member_id: null,
      guest_username: p?.guest_username ? String(p.guest_username) : null,
      member_name: null,
      booked_at: p?.booked_at ?? null,
      canceled_at: p?.canceled_at || null,
      is_cancelled: isCancelled,
    };
  }

  if (!memberId) {
    return {
      external_id,
      participant_type: "deleted",
      member_id: null,
      guest_username: null,
      member_name: null,
      booked_at: p?.booked_at ?? null,
      canceled_at: p?.canceled_at || null,
      is_cancelled: isCancelled,
    };
  }

  return {
    external_id,
    participant_type: "member",
    member_id: memberId,
    guest_username: null,
    member_name: p?.user?.username ?? p?.user?.name ?? "Unknown",
    booked_at: p?.booked_at ?? null,
    canceled_at: p?.canceled_at || null,
    is_cancelled: isCancelled,
  };
}

export function sortParticipants<T extends { canceled_at?: string | null; booked_at?: string | null }>(
  participants: T[]
): T[] {
  return [...participants].sort((a, b) => {
    if (a.canceled_at && !b.canceled_at) return 1;
    if (!a.canceled_at && b.canceled_at) return -1;
    return new Date(a.booked_at ?? 0).getTime() - new Date(b.booked_at ?? 0).getTime();
  });
}

/** Decline fields from an appointment-shaped TakeActive detail payload (not a participant array). */
export function declineFieldsFromDetail(
  data: any
): { is_decline: boolean; decline_message: string | null } | null {
  if (data == null || Array.isArray(data)) return null;
  return {
    is_decline: !!data.is_decline,
    decline_message: data.decline_message ? String(data.decline_message) : null,
  };
}

/** Assign attended/waiting/cancelled; guests and deleted consume capacity. */
export function assignStatus(
  isCancelled: boolean,
  attendedCount: number,
  maxParticipants: number
): { status: "cancelled" | "attended" | "waiting"; nextAttendedCount: number } {
  if (isCancelled) {
    return { status: "cancelled", nextAttendedCount: attendedCount };
  }
  if (attendedCount < maxParticipants) {
    return { status: "attended", nextAttendedCount: attendedCount + 1 };
  }
  return { status: "waiting", nextAttendedCount: attendedCount };
}
