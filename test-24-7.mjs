const BASE = "http://localhost:3001/api/sim";
async function get(path) {
  const r = await fetch(BASE + path);
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function post(path) {
  const r = await fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json" } });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const snap = (st) => st.snapshot ? `cash=${st.snapshot.cash?.toFixed(2)} pos=${st.snapshot.positions?.length} trades=${st.snapshot.trades?.length} hist=${st.snapshot.history?.length} candleCount=${st.snapshot.candleCount}` : "snapshot=null";

(async () => {
  console.log("=== initial ===");
  let s = await get("/state"); console.log("running=", s.body.running, snap(s.body));
  console.log("=== START ===");
  await post("/start");
  console.log("waiting 22s for ticks...");
  await new Promise((r) => setTimeout(r, 22000));
  console.log("=== after 22s ===");
  s = await get("/state"); console.log("running=", s.body.running, snap(s.body));
  console.log("=== RESET ===");
  await post("/reset");
  s = await get("/state"); console.log("running=", s.body.running, snap(s.body), "epoch=", s.body.epoch);
})();
