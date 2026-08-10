/**
 * Local Node runner for backfill-appointment-participants (no Edge timeout).
 *
 * Usage:
 *   node scripts/backfill-appointment-participants.mjs --from=2025-12-31 --to=2026-07-26 --unchecked-only
 *
 * Required env (.env supported):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *   TAKEACTIVE_FIREBASE_KEY, TAKEACTIVE_EMAIL, TAKEACTIVE_PASSWORD
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
// Keep in sync with supabase/functions/_shared/participants.ts
import {
  assignStatus,
  classifyParticipant,
  sortParticipants,
} from "./lib/participants.mjs";

const TAKEACTIVE_DELAY_MS = 3000;
const BATCH_SIZE = 20;
const BATCH_DELAY_MS = 10_000;
const TAKEACTIVE_GROUPS = [
  { master: "BADMINTON-TREPTOW", slug: "badminton-treptow" },
  { master: "VFB-KIEFHOLZ-LEAGUE-TEAM", slug: "vfb-kiefholz-league-team" },
];

function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function berlinToday() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Berlin" });
}

function berlinNowString() {
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
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
}

function groupForMaster(masterCompanyId) {
  return TAKEACTIVE_GROUPS.find((g) => g.master === masterCompanyId);
}

function appointmentDetailUrl(group, appointmentId) {
  return `https://api.takeactive.com/api/${group.master}/appointment/${group.slug}/${appointmentId}`;
}

function parseArgs(argv) {
  const out = {
    from: "2026-01-01",
    to: berlinToday(),
    uncheckedOnly: false,
    force: true,
    limit: null,
  };
  for (const arg of argv) {
    if (arg === "--unchecked-only") out.uncheckedOnly = true;
    else if (arg === "--no-force") out.force = false;
    else if (arg.startsWith("--from=")) out.from = arg.slice(7);
    else if (arg.startsWith("--to=")) out.to = arg.slice(5);
    else if (arg.startsWith("--limit=")) out.limit = Number(arg.slice(8));
  }
  if (out.limit != null && (!Number.isFinite(out.limit) || out.limit <= 0)) {
    throw new Error("--limit must be a positive number");
  }
  return out;
}

let tokenState = null;

async function passwordLogin() {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${env("TAKEACTIVE_FIREBASE_KEY")}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: env("TAKEACTIVE_EMAIL"),
        password: env("TAKEACTIVE_PASSWORD"),
        returnSecureToken: true,
      }),
    }
  );
  const data = await res.json();
  if (!data.idToken || !data.refreshToken) {
    throw new Error(`Firebase login failed: ${JSON.stringify(data)}`);
  }
  return {
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    expiresAt: Math.floor(Date.now() / 1000) + Number(data.expiresIn ?? 3600),
  };
}

async function refreshToken(refresh) {
  const res = await fetch(
    `https://securetoken.googleapis.com/v1/token?key=${env("TAKEACTIVE_FIREBASE_KEY")}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refresh)}`,
    }
  );
  const data = await res.json();
  if (!data.id_token || !data.refresh_token) {
    throw new Error(`Firebase refresh failed: ${JSON.stringify(data)}`);
  }
  return {
    idToken: data.id_token,
    refreshToken: data.refresh_token,
    expiresAt: Math.floor(Date.now() / 1000) + Number(data.expires_in ?? 3600),
  };
}

async function getToken() {
  const now = Math.floor(Date.now() / 1000);
  if (!tokenState) {
    tokenState = await passwordLogin();
    return tokenState.idToken;
  }
  if (tokenState.expiresAt - now > 60) return tokenState.idToken;
  try {
    tokenState = await refreshToken(tokenState.refreshToken);
  } catch (err) {
    console.error("Token refresh failed, password login:", err.message ?? err);
    tokenState = await passwordLogin();
  }
  return tokenState.idToken;
}

async function syncUser(supabase, memberId, apiName) {
  const { data: existing, error: selectErr } = await supabase
    .from("member")
    .select("name")
    .eq("id", memberId)
    .maybeSingle();
  if (selectErr) throw new Error(`member select failed for ${memberId}: ${selectErr.message}`);

  if (!existing) {
    const { error } = await supabase.from("member").insert({
      id: memberId,
      name: apiName,
      event_count: 0,
    });
    if (error) throw new Error(`member insert failed for ${memberId}: ${error.message}`);
  } else if (existing.name !== apiName) {
    const { error } = await supabase.from("member").update({ name: apiName }).eq("id", memberId);
    if (error) throw new Error(`member update failed for ${memberId}: ${error.message}`);
  }
}

/** Load all matching appointments (paginated past PostgREST 1000-row default). */
async function loadAppointments(supabase, { from, to, uncheckedOnly }) {
  const pageSize = 1000;
  const all = [];
  for (let fromIdx = 0; ; fromIdx += pageSize) {
    let query = supabase
      .from("appointment")
      .select("id, max_participants, master_company_id, start_date, start_time, checked")
      .gte("start_date", from)
      .lte("start_date", to)
      .order("start_date", { ascending: true })
      .order("start_time", { ascending: true })
      .order("id", { ascending: true })
      .range(fromIdx, fromIdx + pageSize - 1);

    if (uncheckedOnly) query = query.eq("checked", false);

    const { data, error } = await query;
    if (error) throw new Error(`Failed to load appointments: ${error.message}`);
    if (!data?.length) break;
    all.push(...data);
    if (data.length < pageSize) break;
  }
  return all;
}

function apptStamp(appt) {
  return `${appt.start_date} ${String(appt.start_time).slice(0, 8)}`;
}

function logSummary({ fetched, skipped, total, stoppedAt, reason }) {
  console.log(
    JSON.stringify(
      {
        filled: fetched,
        skipped,
        total,
        stopped_at: stoppedAt,
        reason,
      },
      null,
      2
    )
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const supabase = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));

  console.log("Options:", args);

  const appointments = await loadAppointments(supabase, args);
  const berlinNow = berlinNowString();

  let list = appointments;
  if (args.uncheckedOnly) {
    list = list.filter((appt) => {
      const startStr = `${appt.start_date}T${String(appt.start_time).slice(0, 8)}`;
      return startStr < berlinNow;
    });
  }
  if (args.limit != null) list = list.slice(0, args.limit);

  console.log(`Appointments to process: ${list.length} (batches of ${BATCH_SIZE})`);

  let fetched = 0;
  let skipped = 0;
  let stoppedAt = null;
  const batchCount = Math.ceil(list.length / BATCH_SIZE) || 0;

  try {
    for (let batchIdx = 0; batchIdx < batchCount; batchIdx++) {
      const start = batchIdx * BATCH_SIZE;
      const batch = list.slice(start, start + BATCH_SIZE);
      console.log(
        `\n--- Batch ${batchIdx + 1}/${batchCount} (${batch.length} appointments) ---`
      );

      for (let j = 0; j < batch.length; j++) {
        const i = start + j;
        const appt = batch[j];
        const label = `[${i + 1}/${list.length}] ${apptStamp(appt)} ${appt.id}`;

        if (!args.force) {
          const { count, error: countErr } = await supabase
            .from("appointment_participant")
            .select("id", { count: "exact", head: true })
            .eq("appointment_id", appt.id);
          if (countErr) {
            throw new Error(`Participant count failed for ${appt.id}: ${countErr.message}`);
          }
          if ((count ?? 0) > 0) {
            console.log(`${label} skip already_has_participants`);
            skipped++;
            stoppedAt = apptStamp(appt);
            continue;
          }
        }

        const group = groupForMaster(appt.master_company_id);
        if (!group) {
          console.log(`${label} skip no group for ${appt.master_company_id}`);
          skipped++;
          stoppedAt = apptStamp(appt);
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
          console.log(`${label} skip API ${res.status}: ${text.slice(0, 120)}`);
          skipped++;
          stoppedAt = apptStamp(appt);
          continue;
        }

        const data = await res.json();
        const participants = Array.isArray(data)
          ? data
          : (data.participants ?? data.participant ?? []);

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
          if (!classified) continue;

          if (classified.participant_type === "member" && classified.member_id) {
            await syncUser(supabase, classified.member_id, classified.member_name ?? "Unknown");
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

        const { error: checkErr } = await supabase
          .from("appointment")
          .update({ checked: true })
          .eq("id", String(appt.id));
        if (checkErr) throw new Error(`Failed to mark ${appt.id} checked: ${checkErr.message}`);

        fetched++;
        stoppedAt = apptStamp(appt);
        console.log(`${label} ok participants=${participants.length} upserted=${upserted}`);
      }

      console.log(
        `Batch ${batchIdx + 1}/${batchCount} done — filled=${fetched} skipped=${skipped} stopped_at=${stoppedAt}`
      );

      if (batchIdx < batchCount - 1) {
        console.log(`Waiting ${BATCH_DELAY_MS / 1000}s before next batch...`);
        await sleep(BATCH_DELAY_MS);
      }
    }

    logSummary({
      fetched,
      skipped,
      total: list.length,
      stoppedAt,
      reason: "completed",
    });
  } catch (err) {
    console.error(err);
    logSummary({
      fetched,
      skipped,
      total: list.length,
      stoppedAt,
      reason: "error",
    });
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
