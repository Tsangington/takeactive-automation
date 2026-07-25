import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getToken, resetTokenCache } from "../_shared/takeactiveAuth.ts";
import {
  TAKEACTIVE_DELAY_MS,
  appointmentDetailUrl,
  berlinToday,
  groupForMaster,
  parseDateRange,
  sleep,
} from "../_shared/takeactiveGroups.ts";

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
  }
}

Deno.serve(async (req) => {
  try {
    resetTokenCache();
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const force = body.force !== false; // default true

    let defaultTo = berlinToday();
    if (!body.to) {
      // Extend through latest not-yet-started appointment in DB.
      const { data: upcoming } = await supabase
        .from("appointment")
        .select("start_date, start_time")
        .gte("start_date", berlinToday())
        .order("start_date", { ascending: false })
        .order("start_time", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (upcoming?.start_date) {
        defaultTo = upcoming.start_date;
      }
    }

    const { from, to } = parseDateRange(body, {
      from: "2026-01-01",
      to: defaultTo,
    });

    const { data: appointments, error: apptErr } = await supabase
      .from("appointment")
      .select("id, max_participants, master_company_id, start_date, start_time")
      .gte("start_date", from)
      .lte("start_date", to)
      .order("start_date", { ascending: true })
      .order("start_time", { ascending: true });

    if (apptErr) {
      throw new Error(`Failed to load appointments: ${apptErr.message}`);
    }

    const results: Array<Record<string, unknown>> = [];
    let fetched = 0;
    let skipped = 0;

    for (const appt of appointments ?? []) {
      if (!force) {
        const { count, error: countErr } = await supabase
          .from("appointment_participant")
          .select("id", { count: "exact", head: true })
          .eq("appointment_id", appt.id);

        if (countErr) {
          throw new Error(`Participant count failed for ${appt.id}: ${countErr.message}`);
        }
        if ((count ?? 0) > 0) {
          skipped++;
          results.push({ appointment_id: appt.id, status: "skipped", reason: "already_has_participants" });
          continue;
        }
      }

      const group = groupForMaster(appt.master_company_id);
      if (!group) {
        results.push({
          appointment_id: appt.id,
          status: "skipped",
          reason: `No group for master_company_id=${appt.master_company_id}`,
        });
        skipped++;
        continue;
      }

      await sleep(TAKEACTIVE_DELAY_MS);
      const token = await getToken();
      const detailUrl = appointmentDetailUrl(group, String(appt.id));
      const res = await fetch(detailUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) {
        const text = await res.text();
        results.push({
          appointment_id: appt.id,
          status: "skipped",
          reason: `API ${res.status}: ${text.slice(0, 200)}`,
        });
        skipped++;
        continue;
      }

      const data = await res.json();
      const participants: any[] = Array.isArray(data)
        ? []
        : (data.participants ?? data.participant ?? []);

      if (Array.isArray(data)) {
        results.push({
          appointment_id: appt.id,
          status: "skipped",
          reason: "API returned array instead of appointment detail",
        });
        skipped++;
        continue;
      }

      const sorted = [...participants].sort((a, b) => {
        if (a.canceled_at && !b.canceled_at) return 1;
        if (!a.canceled_at && b.canceled_at) return -1;
        return new Date(a.booked_at).getTime() - new Date(b.booked_at).getTime();
      });

      let attendedCount = 0;
      let upserted = 0;

      for (const p of sorted) {
        const memberId = String(p.user_id ?? p.user?.id ?? "");
        if (!memberId) continue;

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

      fetched++;
      results.push({
        appointment_id: appt.id,
        status: "ok",
        participants: participants.length,
        upserted,
      });
    }

    return new Response(
      JSON.stringify({
        from,
        to,
        force,
        total: appointments?.length ?? 0,
        fetched,
        skipped,
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
