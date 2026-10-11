import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { bookableColumns } from "../_shared/takeactiveGroups.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

async function getToken(): Promise<string> {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${Deno.env.get("TAKEACTIVE_FIREBASE_KEY")}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: Deno.env.get("TAKEACTIVE_EMAIL"),
        password: Deno.env.get("TAKEACTIVE_PASSWORD"),
        returnSecureToken: true,
      }),
    }
  );
  const data = await res.json();
  return data.idToken;
}

const GROUPS = [
  {
    base: Deno.env.get("TAKEACTIVE_API_BASE_1")!,
    group: "badminton-treptow",
  },
  {
    base: Deno.env.get("TAKEACTIVE_API_BASE_2")!,
    group: "vfb-kiefholz-league-team",
  },
];

Deno.serve(async () => {
  const delays = [0, 10, 20, 30, 40, 50];
  const delay = delays[Math.floor(Math.random() * delays.length)];

  if (delay > 0) {
    console.log(`Delaying ${delay} seconds before syncing...`);
    await new Promise((resolve) => setTimeout(resolve, delay * 1000));
  }
  const token = await getToken();
  let totalSynced = 0;

  for (const { base } of GROUPS) {
    const res = await fetch(base, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      console.error(`Failed to fetch from ${base}`);
      continue;
    }

    const appointments: any[] = await res.json();
    const active = appointments.filter((a) => a.status === "ACTIVE");

    // Do not include `checked` — upserting checked:false was resetting
    // appointments already processed by sync-appointment-participants.
    const rows = active.map((a) => ({
      id: String(a.id),
      name: a.name,
      start_date: a.appointment.split("T")[0],
      start_time: a.appointment.split("T")[1],
      max_participants: a.max_participant,
      master_company_id: a.master_company_id,
      ...bookableColumns(a),
    }));

    const { error } = await supabase
      .from("appointment")
      .upsert(rows, { onConflict: "id", ignoreDuplicates: false });

    if (error) {
      console.error(`DB upsert failed for ${base}:`, error);
      continue;
    }

    totalSynced += rows.length;
  }

  return new Response(
    JSON.stringify({ synced: totalSynced }),
    { headers: { "Content-Type": "application/json" } }
  );
});