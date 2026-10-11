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
import {
  assignStatus,
  classifyParticipant,
  declineFieldsFromDetail,
  sortParticipants,
} from "../_shared/participants.ts";

const DEFAULT_LIMIT = 20;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

type AfterCursor = {
  start_date: string;
  start_time: string;
  id: string;
};

function berlinNowString(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
}

function apptKey(appt: { start_date: string; start_time: string; id: string }): string {
  return `${appt.start_date}T${String(appt.start_time).slice(0, 8)}|${appt.id}`;
}

function isAfterCursor(
  appt: { start_date: string; start_time: string; id: string },
  after: AfterCursor
): boolean {
  return apptKey(appt) > apptKey(after);
}

async function syncUser(memberId: string, apiName: string): Promise<void> {
  const selectRes = await supabase
    .from("member")
    .select("name")
    .eq("id", memberId)
    .maybeSingle();

  if (!selectRes) {
    throw new Error(`member select returned undefined for ${memberId}`);
  }
  if (selectRes.error) {
    throw new Error(`member select failed for ${memberId}: ${selectRes.error.message}`);
  }

  const existing = selectRes.data;
  if (!existing) {
    const insertRes = await supabase.from("member").insert({
      id: memberId,
      name: apiName,
      event_count: 0,
    });
    if (!insertRes) {
      throw new Error(`member insert returned undefined for ${memberId}`);
    }
    if (insertRes.error) {
      throw new Error(`member insert failed for ${memberId}: ${insertRes.error.message}`);
    }
  } else if (existing.name !== apiName) {
    const updateRes = await supabase.from("member")
      .update({ name: apiName })
      .eq("id", memberId);
    if (!updateRes) {
      throw new Error(`member update returned undefined for ${memberId}`);
    }
    if (updateRes.error) {
      throw new Error(`member update failed for ${memberId}: ${updateRes.error.message}`);
    }
  }
}

Deno.serve(async (req) => {
  try {
    resetTokenCache();
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const force = body.force !== false; // default true
    // When true: only appointments with checked=false that have already started.
    const uncheckedOnly = body.unchecked_only === true;
    const limit = Number(body.limit) > 0 ? Math.floor(Number(body.limit)) : DEFAULT_LIMIT;
    const after: AfterCursor | null =
      body.after?.start_date && body.after?.id
        ? {
            start_date: String(body.after.start_date),
            start_time: String(body.after.start_time ?? "00:00:00"),
            id: String(body.after.id),
          }
        : null;

    let defaultTo = berlinToday();
    if (!body.to && !uncheckedOnly) {
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

    let query = supabase
      .from("appointment")
      .select("id, max_participants, master_company_id, start_date, start_time, checked")
      .gte("start_date", from)
      .lte("start_date", to)
      .order("start_date", { ascending: true })
      .order("start_time", { ascending: true });

    if (uncheckedOnly) {
      query = query.eq("checked", false);
    }

    const { data: appointments, error: apptErr } = await query;

    if (apptErr) {
      throw new Error(`Failed to load appointments: ${apptErr.message}`);
    }

    const berlinNowStr = berlinNowString();

    const filtered = (appointments ?? []).filter((appt) => {
      if (uncheckedOnly) {
        const startStr = `${appt.start_date}T${String(appt.start_time).slice(0, 8)}`;
        if (!(startStr < berlinNowStr)) return false;
      }
      if (after && !isAfterCursor(appt, after)) return false;
      return true;
    });

    const batch = filtered.slice(0, limit);
    const hasMore = filtered.length > limit;

    const results: Array<Record<string, unknown>> = [];
    let fetched = 0;
    let skipped = 0;

    for (const appt of batch) {
      if (!force) {
        const countRes = await supabase
          .from("appointment_participant")
          .select("id", { count: "exact", head: true })
          .eq("appointment_id", appt.id);

        if (!countRes) {
          throw new Error(`Participant count returned undefined for ${appt.id}`);
        }
        if (countRes.error) {
          throw new Error(`Participant count failed for ${appt.id}: ${countRes.error.message}`);
        }
        if ((countRes.count ?? 0) > 0) {
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
      // Empty array / empty participants means nobody attended — still mark checked.
      const participants: any[] = Array.isArray(data)
        ? data
        : (data.participants ?? data.participant ?? []);

      const clearRes = await supabase
        .from("appointment_participant")
        .delete()
        .eq("appointment_id", String(appt.id));
      if (!clearRes) {
        throw new Error(`appointment_participant clear returned undefined for ${appt.id}`);
      }
      if (clearRes.error) {
        throw new Error(
          `appointment_participant clear failed for ${appt.id}: ${clearRes.error.message}`
        );
      }

      const sorted = sortParticipants(participants);
      let attendedCount = 0;
      let upserted = 0;

      for (const p of sorted) {
        const classified = classifyParticipant(p);
        if (!classified) continue;

        if (classified.participant_type === "member" && classified.member_id) {
          await syncUser(classified.member_id, classified.member_name ?? "Unknown");
        }

        const { status, nextAttendedCount } = assignStatus(
          classified.is_cancelled,
          attendedCount,
          appt.max_participants
        );
        attendedCount = nextAttendedCount;

        const upsertRes = await supabase.from("appointment_participant").upsert(
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

        if (!upsertRes) {
          throw new Error(
            `appointment_participant upsert returned undefined for ${appt.id}/${classified.external_id}`
          );
        }
        if (upsertRes.error) {
          throw new Error(
            `appointment_participant upsert failed for ${appt.id}/${classified.external_id}: ${upsertRes.error.message}`
          );
        }
        upserted++;
      }

      const decline = declineFieldsFromDetail(data);
      const checkRes = await supabase
        .from("appointment")
        .update({ checked: true, ...(decline ?? {}) })
        .eq("id", String(appt.id));

      if (!checkRes) {
        throw new Error(`Failed to mark appointment ${appt.id} checked: undefined response`);
      }
      if (checkRes.error) {
        throw new Error(`Failed to mark appointment ${appt.id} checked: ${checkRes.error.message}`);
      }

      fetched++;
      results.push({
        appointment_id: appt.id,
        status: "ok",
        participants: participants.length,
        upserted,
      });
    }

    // No self-reinvoke — caller must POST again with `after: next_after` if has_more.
    let nextAfter: AfterCursor | null = null;
    if (hasMore && batch.length > 0) {
      const last = batch[batch.length - 1];
      nextAfter = {
        start_date: last.start_date,
        start_time: String(last.start_time).slice(0, 8),
        id: String(last.id),
      };
    }

    return new Response(
      JSON.stringify({
        from,
        to,
        force,
        unchecked_only: uncheckedOnly,
        limit,
        after,
        total_remaining: filtered.length,
        batch: batch.length,
        fetched,
        skipped,
        has_more: hasMore,
        next_after: nextAfter,
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
