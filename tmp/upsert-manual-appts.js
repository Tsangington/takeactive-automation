const fs = require("fs");
const appts = JSON.parse(fs.readFileSync("tmp/manual-appts.json", "utf8"));
const esc = (s) => String(s).replace(/'/g, "''");
const values = appts
  .map((a) => {
    const [d, t] = a.appointment.split("T");
    return `('${a.id}', '${esc(a.name)}', '${d}', '${t}', ${a.max_participant}, '${esc(a.master_company_id)}')`;
  })
  .join(",\n");
const sql = `INSERT INTO public.appointment (id, name, start_date, start_time, max_participants, master_company_id)
VALUES
${values}
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  start_date = EXCLUDED.start_date,
  start_time = EXCLUDED.start_time,
  max_participants = EXCLUDED.max_participants,
  master_company_id = EXCLUDED.master_company_id;
`;
fs.writeFileSync("tmp/manual-appts.sql", sql);
console.log("rows", appts.length);
