import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getToken } from "../_shared/takeactiveAuth.ts";
import { appointmentDetailUrl, groupForMaster } from "../_shared/takeactiveGroups.ts";
import {
  assignStatus,
  classifyParticipant,
  sortParticipants,
} from "../_shared/participants.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

async function syncUser(memberId: string, apiName: string): Promise<void> {
  const { data: existing, error: selectErr } = await supabase
    .from("member")
    .select("name")
    .eq("id", memberId)
    .maybeSingle();

  if (selectErr) {
    throw new Error(`member select failed for ${memberId}: ${selectErr.message}`);
  }

  if (!existing) {
    const { error } = await supabase.from("member").insert({
      id: memberId,
      name: apiName,
      event_count: 0,
    });
    if (error) {
      throw new Error(`member insert failed for ${memberId}: ${error.message}`);
    }
  } else if (existing.name !== apiName) {
    const { error } = await supabase.from("member")
      .update({ name: apiName })
      .eq("id", memberId);

    if (error) {
      throw new Error(`member update failed for ${memberId}: ${error.message}`);
    }

    console.log(`Updated name for ${memberId}: "${existing.name}" → "${apiName}"`);
  }
}

async function syncAppointmentParticipants(
  appt: { id: string; max_participants: number; master_company_id: string },
  participants: any[]
): Promise<number> {
  // Replace the set for this appointment so removed/guest/deleted rows stay correct
  // and pre-migration rows without external_id cannot collide on member_id.
  const { error: clearErr } = await supabase
    .from("appointment_participant")
    .delete()
    .eq("appointment_id", String(appt.id));
  if (clearErr) {
    throw new Error(
      `appointment_participant clear failed for ${appt.id}: ${clearErr.message}`
    );
  }

  const sorted = sortParticipants(participants);
  let attendedCount = 0;
  let upserted = 0;

  for (const p of sorted) {
    const classified = classifyParticipant(p);
    if (!classified) {
      console.error(`Participant missing id on appointment ${appt.id}`);
      continue;
    }

    if (classified.participant_type === "member" && classified.member_id) {
      await syncUser(classified.member_id, classified.member_name ?? "Unknown");
    }

    const { status, nextAttendedCount } = assignStatus(
      classified.is_cancelled,
      attendedCount,
      appt.max_participants
    );
    attendedCount = nextAttendedCount;

    const { error: upsertErr } = await supabase.from("appointment_participant").upsert(
      {
        appointment_id: String(appt.id),
        external_id: classified.external_id,
        member_id: classified.member_id,
        participant_type: classified.participant_type,
        guest_username: classified.guest_username,
        status,
        booked_at: classified.booked_at,
        canceled_at: classified.canceled_at,
      },
      { onConflict: "appointment_id,external_id" }
    );

    if (upsertErr) {
      throw new Error(
        `appointment_participant upsert failed for ${appt.id}/${classified.external_id}: ${upsertErr.message}`
      );
    }
    upserted++;
  }

  return upserted;
}

Deno.serve(async () => {
  try {
    const now = new Date();
    const in20min = new Date(now.getTime() + 20 * 60 * 1000).toISOString();

    const { data: upcoming, error: fetchErr } = await supabase.rpc(
      "get_upcoming_unchecked_appointments",
      {
        from_time: now.toISOString(),
        to_time: in20min,
      }
    );

    if (fetchErr) {
      return new Response(
        JSON.stringify({ error: "RPC failed", details: fetchErr.message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    if (!upcoming?.length) {
      return new Response(
        JSON.stringify({ message: "No upcoming unchecked appointments" }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    const results: Array<Record<string, unknown>> = [];

    for (const appt of upcoming) {
      const group = groupForMaster(appt.master_company_id);

      if (!group) {
        const msg = `No group config for master_company_id=${appt.master_company_id}`;
        console.error(msg);
        results.push({ appointment_id: appt.id, status: "skipped", reason: msg });
        continue;
      }

      const token = await getToken();
      const detailUrl = appointmentDetailUrl(group, String(appt.id));
      const res = await fetch(detailUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) {
        const body = await res.text();
        const msg = `API ${res.status} for ${detailUrl}: ${body.slice(0, 300)}`;
        console.error(msg);
        results.push({ appointment_id: appt.id, status: "skipped", reason: msg });
        continue;
      }

      const data = await res.json();
      // Empty array / empty participants means nobody attended — still mark checked.
      const participants: any[] = Array.isArray(data)
        ? data
        : (data.participants ?? data.participant ?? []);

      const upserted = await syncAppointmentParticipants(appt, participants);

      const { error: checkErr } = await supabase
        .from("appointment")
        .update({ checked: true })
        .eq("id", String(appt.id));

      if (checkErr) {
        throw new Error(`Failed to mark appointment ${appt.id} checked: ${checkErr.message}`);
      }

      results.push({
        appointment_id: appt.id,
        status: "ok",
        participants: participants.length,
        upserted,
      });
    }

    const succeeded = results.filter((r) => r.status === "ok").length;
    if (succeeded > 0) {
      await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/sync-estimate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${Deno.env.get("SUPABASE_ANON_KEY")}` },
      });
    }

    return new Response(
      JSON.stringify({
        processed: upcoming.length,
        succeeded,
        results,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
