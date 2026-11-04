import test from "node:test"; import assert from "node:assert/strict";
import { stripDelayDates, customerSchedule, syncDelayNotes } from "./portals.js";
function db(installs, notes) { return { prepare(sql) { let a = []; return { bind(...x) { a = x; return this; },
  async all() { return { results: /FROM installs/.test(sql) ? installs : notes.slice().sort((p, q) => /DESC/.test(sql) ? q.id - p.id : p.id - q.id) }; },
  async first() { return null; },
  async run() { if (/UPDATE job_notes/.test(sql)) notes.find((n) => n.id === a[1]).text = a[0]; } }; } }; }
test("strip dates from delay reasons", () => {
  assert.equal(stripDelayDates("Rain last week pushed us 1 day. Shop day Mon Nov 10, install Tue Nov 11."), "Rain last week pushed us 1 day.");
  assert.equal(stripDelayDates("Weather"), "Weather");
});
test("Dillon: delay text never disagrees with live dates", async () => {
  const notes = [{ id: 10, text: "shed: delay \u2014 Rain last week pushed us 1 day. Shop day Mon Nov 10, install Tue Nov 11.", created_at: "x" }];
  const env = { DB: db([{ id: 44, item: "shop", install_date: "2026-11-09", days: 1 }, { id: 41, item: "shed", install_date: "2026-11-10", days: 1 }], notes) };
  const s = await customerSchedule(env, 81);
  assert.equal(s.delays[0].reason, "Rain last week pushed us 1 day.");
  assert.deepEqual(s.delays[0].current.map((c) => c.start), ["2026-11-09", "2026-11-10"]);
  assert.equal(await syncDelayNotes(env, 81), 1);
  assert.equal(notes[0].text, "shed: delay \u2014 Rain last week pushed us 1 day.");
});
