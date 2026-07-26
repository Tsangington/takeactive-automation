import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getToken } from "../_shared/takeactiveAuth.ts";
import { appointmentDetailUrl, groupForMaster } from "../_shared/takeactiveGroups.ts";

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

      const sorted = [...participants].sort((a, b) => {
        if (a.canceled_at && !b.canceled_at) return 1;
        if (!a.canceled_at && b.canceled_at) return -1;
        return new Date(a.booked_at).getTime() - new Date(b.booked_at).getTime();
      });

      let attendedCount = 0;
      let upserted = 0;

      for (const p of sorted) {
        const memberId = String(p.user_id ?? p.user?.id ?? "");
        if (!memberId) {
          console.error(`Participant missing user_id on appointment ${appt.id}`);
          continue;
        }

        const memberName = p.user?.username ?? p.user?.name ?? "Unknown";
        const isCancelled = !!p.canceled_at && p.canceled_at !== "";

        await syncUser(memberId, memberName);

        let status: string;
        if (isCancelled) {
          status = "cancelled";
        } else if (attendedCount < appt.max_participants) {
          status = "attended";
          attendedCount++;
        } else {
          status = "waiting";
        }

        const { error: upsertErr } = await supabase.from("appointment_participant").upsert(
          {
            appointment_id: String(appt.id),
            member_id: memberId,
            status,
            booked_at: p.booked_at,
            canceled_at: p.canceled_at || null,
          },
          { onConflict: "appointment_id,member_id" }
        );

        if (upsertErr) {
          throw new Error(
            `appointment_participant upsert failed for ${appt.id}/${memberId}: ${upsertErr.message}`
          );
        }
        upserted++;
      }

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
      await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/sync-sheet`, {
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
