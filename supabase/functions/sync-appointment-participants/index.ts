import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

async function syncUser(memberId: string, apiName: string): Promise<void> {
  // Check current name in DB
  const { data: existing } = await supabase
    .from("member")
    .select("name")
    .eq("id", memberId)
    .single();

  if (!existing) {
    // New member — insert with default event_count
    await supabase.from("member").insert({
      id: memberId,
      name: apiName,
      event_count: 0,
    });
  } else if (existing.name !== apiName) {
    // Name has changed — update it
    await supabase.from("member")
      .update({ name: apiName })
      .eq("id", memberId);

    console.log(`Updated name for ${memberId}: "${existing.name}" → "${apiName}"`);
  }
  // If name matches, do nothing
}

const GROUPS = [
  {
    base: Deno.env.get("TAKEACTIVE_API_BASE_1")!,
    master: "VFB-KIEFHOLZ-LEAGUE-TEAM",
  },
  {
    base: Deno.env.get("TAKEACTIVE_API_BASE_2")!,
    master: "BADMINTON-TREPTOW",
  },
];

Deno.serve(async () => {
  const now = new Date();
  const in20min = new Date(now.getTime() + 20 * 60 * 1000).toISOString();

  const { data: upcoming, error: fetchErr } = await supabase.rpc(
  "get_upcoming_unchecked_appointments",
  {
    from_time: now.toISOString(),
    to_time: in20min,
  }
  );

  // 2. If nothing upcoming, exit early — no login needed
  if (fetchErr || !upcoming?.length) {
    return new Response(
      JSON.stringify({ message: "No upcoming unchecked appointments" }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  // 3. Only login if there are actually appointments to process
  const token = await getToken();

  for (const appt of upcoming) {
    // 4. Match appointment to its group
    const groupConfig = GROUPS.find((g) => g.master === appt.master_company_id);

    if (!groupConfig) {
      console.error(`No group config found for appointment ${appt.id}`);
      continue;
    }

    // 5. Fetch appointment detail with participants
    const res = await fetch(`${groupConfig.base}/${appt.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) continue;

    const data = await res.json();
    const participants: any[] = data.participants ?? [];

    // 6. Sort by booked_at ascending, cancelled go last
    const sorted = [...participants].sort((a, b) => {
      if (a.canceled_at && !b.canceled_at) return 1;
      if (!a.canceled_at && b.canceled_at) return -1;
      return new Date(a.booked_at).getTime() - new Date(b.booked_at).getTime();
    });

    // 7. Process each participant
    let attendedCount = 0;
    for (const p of sorted) {
      const memberId = String(p.user_id);
      const memberName = p.user?.username ?? "Unknown";
      const isCancelled = !!p.canceled_at && p.canceled_at !== "";

      // 7a. Sync user — insert if new, update name if changed
      await syncUser(memberId, memberName);

      // 7b. Determine status
      let status: string;
      if (isCancelled) {
        status = "cancelled";
      } else if (attendedCount < appt.max_participants) {
        status = "attended";
        attendedCount++;
      } else {
        status = "waiting";
      }

      // 7c. Upsert into appointment_participant
      await supabase.from("appointment_participant").upsert(
        {
          appointment_id: String(appt.id),
          member_id: memberId,
          status,
          booked_at: p.booked_at,
        },
        { onConflict: "appointment_id,member_id" }
      );

      // 7d. Increment event_count if attended
      if (status === "attended") {
        await supabase.rpc("increment_event_count", {
          member_id_input: memberId,
        });
      }
    }

    // 8. Mark appointment as checked
    await supabase
      .from("appointment")
      .update({ checked: true })
      .eq("id", String(appt.id));
  }

  // 9. Trigger sync-sheet
  await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/sync-sheet`, {
    method: "POST",
    headers: { Authorization: `Bearer ${Deno.env.get("SUPABASE_ANON_KEY")}` },
  });

  return new Response(
    JSON.stringify({ processed: upcoming.length }),
    { headers: { "Content-Type": "application/json" } }
  );
});