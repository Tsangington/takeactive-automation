/**
 * Fetch each stored appointment from TakeActive and stamp is_decline.
 * Declined slots keep appointment_participant rows but status becomes cancelled.
 *
 * Usage:
 *   node scripts/stamp-declined-appointments.mjs
 *   node scripts/stamp-declined-appointments.mjs --from=2025-12-31 --to=2026-08-24
 *   node scripts/stamp-declined-appointments.mjs --limit=10
 *
 * Required env (.env supported):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *   TAKEACTIVE_FIREBASE_KEY, TAKEACTIVE_EMAIL, TAKEACTIVE_PASSWORD
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { declineFieldsFromDetail } from "./lib/participants.mjs";

const TAKEACTIVE_DELAY_MS = 1000;
const BATCH_SIZE = 20;
const BATCH_DELAY_MS = 5_000;
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

function groupForMaster(masterCompanyId) {
  return TAKEACTIVE_GROUPS.find((g) => g.master === masterCompanyId);
}

function appointmentDetailUrl(group, appointmentId) {
  return `https://api.takeactive.com/api/${group.master}/appointment/${group.slug}/${appointmentId}`;
}

function parseArgs(argv) {
  const out = { from: null, to: null, limit: null };
  for (const arg of argv) {
    if (arg.startsWith("--from=")) out.from = arg.slice(7);
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

async function loadAppointments(supabase, { from, to }) {
  const pageSize = 1000;
  const all = [];
  for (let fromIdx = 0; ; fromIdx += pageSize) {
    let query = supabase
      .from("appointment")
      .select("id, master_company_id, start_date, start_time, is_decline")
      .order("start_date", { ascending: true })
      .order("start_time", { ascending: true })
      .order("id", { ascending: true })
      .range(fromIdx, fromIdx + pageSize - 1);

    if (from) query = query.gte("start_date", from);
    if (to) query = query.lte("start_date", to);

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const supabase = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));

  console.log("Options:", args);

  let list = await loadAppointments(supabase, args);
  if (args.limit != null) list = list.slice(0, args.limit);

  console.log(`Appointments to check: ${list.length} (batches of ${BATCH_SIZE})`);

  let checked = 0;
  let declined = 0;
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

        const group = groupForMaster(appt.master_company_id);
        if (!group) {
          console.log(`${label} skip no group for ${appt.master_company_id}`);
          skipped++;
          stoppedAt = apptStamp(appt);
          continue;
        }

        await sleep(TAKEACTIVE_DELAY_MS);
        const token = await getToken();
        const res = await fetch(appointmentDetailUrl(group, String(appt.id)), {
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
        const decline = declineFieldsFromDetail(data);
        if (!decline) {
          console.log(`${label} skip detail has no appointment decline fields`);
          skipped++;
          stoppedAt = apptStamp(appt);
          continue;
        }

        const { error: apptErr } = await supabase
          .from("appointment")
          .update({
            is_decline: decline.is_decline,
            decline_message: decline.decline_message,
          })
          .eq("id", String(appt.id));
        if (apptErr) {
          throw new Error(`appointment update failed for ${appt.id}: ${apptErr.message}`);
        }

        let cancelledParticipants = 0;
        if (decline.is_decline) {
          const { data: updated, error: partErr } = await supabase
            .from("appointment_participant")
            .update({ status: "cancelled" })
            .eq("appointment_id", String(appt.id))
            .neq("status", "cancelled")
            .select("id");
          if (partErr) {
            throw new Error(
              `appointment_participant update failed for ${appt.id}: ${partErr.message}`
            );
          }
          cancelledParticipants = updated?.length ?? 0;
          declined++;
        }

        checked++;
        stoppedAt = apptStamp(appt);
        console.log(
          `${label} ${decline.is_decline ? "declined" : "ok"} participants_cancelled=${cancelledParticipants}`
        );
      }

      console.log(
        `Batch ${batchIdx + 1}/${batchCount} done — checked=${checked} declined=${declined} skipped=${skipped}`
      );

      if (batchIdx < batchCount - 1) {
        console.log(`Waiting ${BATCH_DELAY_MS / 1000}s before next batch...`);
        await sleep(BATCH_DELAY_MS);
      }
    }

    console.log(
      JSON.stringify({ checked, declined, skipped, total: list.length, stopped_at: stoppedAt }, null, 2)
    );
  } catch (err) {
    console.error(err);
    console.log(
      JSON.stringify(
        { checked, declined, skipped, total: list.length, stopped_at: stoppedAt, reason: "error" },
        null,
        2
      )
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
