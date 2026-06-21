import { useState, useEffect, useMemo, useRef } from "react";
import { ChevronLeft, ChevronRight, Target, Calendar as CalIcon, TrendingUp, Plus, X, DollarSign, Trash2, Upload, Loader2, Check, Clock, BarChart3, Banknote, CalendarClock, Sparkles, PlusCircle, Layers } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from "recharts";

const BASE_WAGE = 2.17;
const AM_COLOR = "#38bdf8";
const PM_COLOR = "#a78bfa";
const fmt = (n) => "$" + (Math.round(n * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt0 = (n) => "$" + Math.round(n).toLocaleString("en-US");
const toKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parseKey = (k) => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); };
const todayKey = () => toKey(new Date());
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const hoursBetween = (start, end) => {
  if (!start || !end) return 0;
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins < 0) mins += 24 * 60;
  return mins / 60;
};
const to12 = (t) => { if (!t) return ""; let [h, m] = t.split(":").map(Number); const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12; return `${h}:${String(m).padStart(2, "0")} ${ap}`; };
// AM shifts end ~5pm, PM shifts start ~5pm -> split by start time at 3pm
const dayPart = (s) => { if (!s || !s.start) return null; const [h, m] = s.start.split(":").map(Number); return (h + m / 60) < 15 ? "AM" : "PM"; };
const partOf = (s) => dayPart(s) || "AM";
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const statify = (rs) => { if (!rs.length) return null; const m = avg(rs); const v = rs.length > 1 ? rs.reduce((a, b) => a + (b - m) ** 2, 0) / (rs.length - 1) : 0; return { mean: m, sd: Math.sqrt(v), n: rs.length }; };

const normShift = (s) => ({ tips: Number(s.tips) || 0, cashTips: Number(s.cashTips) || 0, start: s.start || "", end: s.end || "" });
const normalizeEntry = (v) => {
  if (v && Array.isArray(v.shifts)) return { shifts: v.shifts.map(normShift) };
  if (typeof v === "number") return { shifts: [{ tips: v, cashTips: 0, start: "", end: "" }] };
  return { shifts: [normShift(v)] };
};

const fileToBase64 = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result.split(",")[1]); r.onerror = () => rej(new Error("read failed")); r.readAsDataURL(file); });
async function callClaude(base64, mediaType, prompt) {
  const response = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1500, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: mediaType, data: base64 } }, { type: "text", text: prompt }] }] }) });
  const data = await response.json();
  const text = data.content.filter((i) => i.type === "text").map((i) => i.text).join("");
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}
const reportPrompt = `This is a Toast POS "Shift Review" report screenshot from a Topgolf employee. Extract:
- date (header, YYYY-MM-DD)
- start and end time (the shift window in the header like "12:27 PM - 4:53 PM"), 24-hour HH:MM
- tips: the "Non-cash tips" value near the bottom. If not visible, use the "Tip" Total from the Credit Tip Audit section.
Respond ONLY with raw JSON, no markdown: {"date":"YYYY-MM-DD","start":"HH:MM","end":"HH:MM","tips":NUMBER}. Use null for anything unreadable.`;
const schedulePrompt = (todayISO) => `This is a screenshot of a work schedule app ("My Schedule") for a Topgolf employee whose role is "Bay Host". The current date is ${todayISO}; use it to infer the correct year for each date.
Extract every day shown that has shift content. Two kinds:
- Scheduled shift: has a specific time range like "8:30 AM - 5:30 PM" and a role. status="scheduled".
- Available (open) shift to pick up: shows "X Shift(s) Available" with only an AM or PM tag, no specific time. status="available".
A single day may have both an AM and a PM available entry; return them separately. Ignore week-summary header rows.
Respond ONLY with raw JSON, no markdown:
{"shifts":[{"date":"YYYY-MM-DD","status":"scheduled","start":"HH:MM","end":"HH:MM","role":"Bay Host","period":"AM"},{"date":"YYYY-MM-DD","status":"available","period":"AM"}]}
Use 24-hour HH:MM. For available shifts set start and end to null. period is "AM" or "PM" from the tag.`;

export default function TipsDashboard() {
  const [entries, setEntries] = useState({});
  const [goalAmount, setGoalAmount] = useState("");
  const [goalDate, setGoalDate] = useState("");
  const [rateUnit, setRateUnit] = useState("day");
  const [chartMetric, setChartMetric] = useState("tips");
  const [viewMonth, setViewMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [selected, setSelected] = useState(null);
  const [editShifts, setEditShifts] = useState([{ card: "", cash: "", start: "", end: "" }]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [procMsg, setProcMsg] = useState("");
  const [staged, setStaged] = useState([]);
  const [schedule, setSchedule] = useState([]);
  const [schedBusy, setSchedBusy] = useState(false);
  const [schedMsg, setSchedMsg] = useState("");
  const fileRef = useRef(null);
  const schedRef = useRef(null);

  useEffect(() => {
    (async () => {
      let loaded = null;
      try { const e = await window.storage.get("tips-entries-v3"); if (e && e.value) loaded = JSON.parse(e.value); } catch {}
      if (!loaded) { try { const e2 = await window.storage.get("tips-entries-v2"); if (e2 && e2.value) { const o = JSON.parse(e2.value); loaded = {}; for (const k in o) loaded[k] = normalizeEntry(o[k]); } } catch {} }
      if (!loaded) { try { const e1 = await window.storage.get("tips-entries"); if (e1 && e1.value) { const o = JSON.parse(e1.value); loaded = {}; for (const k in o) loaded[k] = normalizeEntry(o[k]); } } catch {} }
      if (loaded) { const n = {}; for (const k in loaded) n[k] = normalizeEntry(loaded[k]); setEntries(n); }
      try { const g = await window.storage.get("tips-goal"); if (g && g.value) { const gg = JSON.parse(g.value); setGoalAmount(gg.amount || ""); setGoalDate(gg.date || ""); } } catch {}
      try { const s = await window.storage.get("tips-schedule"); if (s && s.value) setSchedule(JSON.parse(s.value)); } catch {}
      setLoading(false);
    })();
  }, []);

  const saveEntries = async (next) => { setEntries(next); try { await window.storage.set("tips-entries-v3", JSON.stringify(next)); } catch {} };
  const saveGoal = async (amount, date) => { try { await window.storage.set("tips-goal", JSON.stringify({ amount, date })); } catch {} };
  const saveSchedule = async (s) => { setSchedule(s); try { await window.storage.set("tips-schedule", JSON.stringify(s)); } catch {} };

  const shiftList = useMemo(() => {
    const arr = [];
    Object.entries(entries).forEach(([date, v]) => {
      (v.shifts || []).forEach((s) => {
        const card = Number(s.tips) || 0, cash = Number(s.cashTips) || 0;
        arr.push({ date, card, cash, tips: card + cash, start: s.start || "", end: s.end || "", hours: hoursBetween(s.start, s.end), part: partOf(s) });
      });
    });
    arr.sort((a, b) => b.date.localeCompare(a.date) || (a.part === b.part ? 0 : a.part === "AM" ? -1 : 1));
    return arr;
  }, [entries]);

  const total = useMemo(() => shiftList.reduce((a, b) => a + b.tips, 0), [shiftList]);
  const totalHours = useMemo(() => shiftList.reduce((a, b) => a + b.hours, 0), [shiftList]);
  const maxShift = useMemo(() => Math.max(0, ...shiftList.map((e) => e.tips)), [shiftList]);
  const avgHourly = totalHours > 0 ? total / totalHours : 0;

  const goal = Number(goalAmount) || 0;
  const remaining = Math.max(0, goal - total);
  const daysLeft = useMemo(() => { if (!goalDate) return 0; const t = new Date(); t.setHours(0, 0, 0, 0); const g = parseKey(goalDate); g.setHours(0, 0, 0, 0); return Math.round((g - t) / 86400000) + 1; }, [goalDate]);
  const required = useMemo(() => { if (daysLeft <= 0 || remaining <= 0) return 0; if (rateUnit === "day") return remaining / daysLeft; if (rateUnit === "week") return remaining / (daysLeft / 7); return remaining / (daysLeft / 30.44); }, [remaining, daysLeft, rateUnit]);
  const pct = goal > 0 ? Math.min(100, (total / goal) * 100) : 0;

  const monthTotal = useMemo(() => { const prefix = `${viewMonth.getFullYear()}-${String(viewMonth.getMonth() + 1).padStart(2, "0")}`; return shiftList.filter((e) => e.date.startsWith(prefix)).reduce((a, e) => a + e.tips, 0); }, [shiftList, viewMonth]);

  const byDayPart = useMemo(() => {
    const b = DOW.map((d) => ({ label: d, am: { tips: 0, hours: 0, n: 0 }, pm: { tips: 0, hours: 0, n: 0 } }));
    shiftList.forEach((s) => { const wd = parseKey(s.date).getDay(); const slot = s.part === "PM" ? "pm" : "am"; b[wd][slot].tips += s.tips; b[wd][slot].hours += s.hours; b[wd][slot].n += 1; });
    return b.map((x) => ({ label: x.label, amTips: x.am.n ? x.am.tips / x.am.n : 0, pmTips: x.pm.n ? x.pm.tips / x.pm.n : 0, amHourly: x.am.hours ? x.am.tips / x.am.hours + BASE_WAGE : 0, pmHourly: x.pm.hours ? x.pm.tips / x.pm.hours + BASE_WAGE : 0, amN: x.am.n, pmN: x.pm.n }));
  }, [shiftList]);
  const amKey = chartMetric === "tips" ? "amTips" : "amHourly";
  const pmKey = chartMetric === "tips" ? "pmTips" : "pmHourly";
  const metricSuffix = chartMetric === "hourly" ? "/hr" : "";

  const forecast = useMemo(() => {
    if (!schedule.length) return null;
    const worked = shiftList.filter((s) => s.hours > 0);
    const statAll = statify(worked.map((s) => s.tips / s.hours));
    const statDP = (wd, part) => statify(worked.filter((s) => parseKey(s.date).getDay() === wd && s.part === part).map((s) => s.tips / s.hours));
    const statPart = (part) => statify(worked.filter((s) => s.part === part).map((s) => s.tips / s.hours));
    const amHist = worked.filter((s) => s.part === "AM"), pmHist = worked.filter((s) => s.part === "PM");
    const amHours = amHist.length ? avg(amHist.map((s) => s.hours)) : 7;
    const pmHours = pmHist.length ? avg(pmHist.map((s) => s.hours)) : 6;
    const predict = (s, hours) => { if (!s || hours <= 0) return null; const band = s.n > 1 ? s.sd : s.mean * 0.25; return { point: s.mean * hours, low: Math.max(0, (s.mean - band) * hours), high: (s.mean + band) * hours }; };
    const predFor = (date, part, hours) => predict(statDP(parseKey(date).getDay(), part) || statPart(part) || statAll, hours);
    const scheduled = schedule.filter((x) => x.status === "scheduled").map((x) => { const hours = hoursBetween(x.start, x.end); const part = dayPart(x) || "AM"; return { ...x, hours, part, pred: predFor(x.date, part, hours) }; }).sort((a, b) => a.date.localeCompare(b.date));
    const available = schedule.filter((x) => x.status === "available").map((x) => { const part = x.period === "PM" ? "PM" : "AM"; const hours = part === "AM" ? amHours : pmHours; return { ...x, part, hours, pred: predFor(x.date, part, hours) }; }).sort((a, b) => a.date.localeCompare(b.date) || (a.part === "AM" ? -1 : 1));
    const byDate = {};
    scheduled.forEach((s) => { byDate[s.date] = byDate[s.date] || {}; byDate[s.date][s.part] = { point: s.pred ? s.pred.point : null, kind: "scheduled" }; });
    available.forEach((s) => { byDate[s.date] = byDate[s.date] || {}; if (!byDate[s.date][s.part]) byDate[s.date][s.part] = { point: s.pred ? s.pred.point : null, kind: "available" }; });
    return { scheduled, available, byDate, statAll, sampleN: worked.length };
  }, [schedule, shiftList]);

  const fc = useMemo(() => {
    if (!forecast) return null;
    const sh = forecast.scheduled;
    const schedHours = sh.reduce((a, s) => a + s.hours, 0);
    const schedTips = sh.reduce((a, s) => a + (s.pred ? s.pred.point : 0), 0);
    const schedLow = sh.reduce((a, s) => a + (s.pred ? s.pred.low : 0), 0);
    const schedHigh = sh.reduce((a, s) => a + (s.pred ? s.pred.high : 0), 0);
    const avHours = forecast.available.reduce((a, s) => a + s.hours, 0);
    const avTips = forecast.available.reduce((a, s) => a + (s.pred ? s.pred.point : 0), 0);
    return { schedHours, schedTips, schedLow, schedHigh, schedTake: schedTips + BASE_WAGE * schedHours, avHours, avTips, grandTips: schedTips + avTips, grandTake: schedTips + avTips + BASE_WAGE * (schedHours + avHours) };
  }, [forecast]);

  const grid = useMemo(() => {
    const y = viewMonth.getFullYear(), m = viewMonth.getMonth();
    const first = new Date(y, m, 1).getDay(); const days = new Date(y, m + 1, 0).getDate(); const cells = [];
    for (let i = 0; i < first; i++) cells.push(null);
    for (let d = 1; d <= days; d++) cells.push(new Date(y, m, d));
    return cells;
  }, [viewMonth]);

  const openDay = (date) => {
    const k = toKey(date); setSelected(k); const e = entries[k];
    if (e && e.shifts && e.shifts.length) setEditShifts(e.shifts.map((s) => ({ card: s.tips ? String(s.tips) : "", cash: s.cashTips ? String(s.cashTips) : "", start: s.start || "", end: s.end || "" })));
    else setEditShifts([{ card: "", cash: "", start: "", end: "" }]);
  };
  const toggleDouble = () => {
    if (editShifts.length === 1) {
      const s1 = editShifts[0];
      setEditShifts([{ ...s1, start: s1.start || "09:00", end: "17:00" }, { card: "", cash: "", start: "17:00", end: s1.end || "00:00" }]);
    } else setEditShifts([editShifts[0]]);
  };
  const updateShift = (idx, field, val) => setEditShifts((arr) => arr.map((s, i) => (i === idx ? { ...s, [field]: val } : s)));
  const commitDay = async () => {
    if (!selected) return;
    const shifts = editShifts.map((s) => ({ tips: parseFloat(s.card) || 0, cashTips: parseFloat(s.cash) || 0, start: s.start || "", end: s.end || "" })).filter((s) => s.tips !== 0 || s.cashTips !== 0 || s.start || s.end);
    const next = { ...entries };
    if (!shifts.length) delete next[selected]; else next[selected] = { shifts };
    await saveEntries(next); setSelected(null);
  };
  const removeDay = async () => { if (!selected) return; const next = { ...entries }; delete next[selected]; await saveEntries(next); setSelected(null); };

  const onFiles = async (files) => {
    const arr = Array.from(files).filter((f) => f.type.startsWith("image/")); if (!arr.length) return;
    setProcessing(true); setStaged([]); const results = [];
    for (let i = 0; i < arr.length; i++) { setProcMsg(`Reading report ${i + 1} of ${arr.length}...`); try { const b64 = await fileToBase64(arr[i]); const r = await callClaude(b64, arr[i].type, reportPrompt); results.push({ id: Math.random().toString(36).slice(2), date: r.date || "", start: r.start || "", end: r.end || "", tips: r.tips != null ? String(r.tips) : "", error: null }); } catch { results.push({ id: Math.random().toString(36).slice(2), date: "", start: "", end: "", tips: "", error: "Could not read this image. Enter values manually." }); } }
    setStaged(results); setProcessing(false); setProcMsg(""); if (fileRef.current) fileRef.current.value = "";
  };
  const onScheduleFiles = async (files) => {
    const arr = Array.from(files).filter((f) => f.type.startsWith("image/")); if (!arr.length) return;
    setSchedBusy(true); const today = toKey(new Date()); let shifts = [];
    for (let i = 0; i < arr.length; i++) { setSchedMsg(`Reading schedule ${i + 1} of ${arr.length}...`); try { const b64 = await fileToBase64(arr[i]); const r = await callClaude(b64, arr[i].type, schedulePrompt(today)); if (r && Array.isArray(r.shifts)) shifts = shifts.concat(r.shifts); } catch {} }
    const cleaned = shifts.filter((s) => s.date).map((s) => ({ date: s.date, status: s.status === "available" ? "available" : "scheduled", start: s.start || "", end: s.end || "", period: s.period || (s.start ? (Number(s.start.split(":")[0]) < 15 ? "AM" : "PM") : "AM"), role: s.role || "Bay Host" }));
    await saveSchedule(cleaned); setSchedBusy(false); setSchedMsg(""); if (schedRef.current) schedRef.current.value = "";
  };

  const updateStaged = (id, f, v) => setStaged((s) => s.map((r) => (r.id === id ? { ...r, [f]: v } : r)));
  const removeStaged = (id) => setStaged((s) => s.filter((r) => r.id !== id));
  const importStaged = async () => {
    const next = { ...entries };
    staged.forEach((r) => {
      if (!r.date) return;
      const newShift = { tips: Number(r.tips) || 0, cashTips: 0, start: r.start || "", end: r.end || "" };
      const np = partOf(newShift);
      const existing = next[r.date] ? [...next[r.date].shifts] : [];
      const sameIdx = existing.findIndex((s) => partOf(s) === np);
      if (sameIdx >= 0) existing[sameIdx] = { ...existing[sameIdx], tips: newShift.tips, start: newShift.start, end: newShift.end };
      else existing.push(newShift);
      next[r.date] = { shifts: existing };
    });
    await saveEntries(next); setStaged([]);
  };

  if (loading) return <div className="flex items-center justify-center h-96 text-slate-400">Loading your dashboard...</div>;

  const editTotal = editShifts.reduce((a, s) => a + (parseFloat(s.card) || 0) + (parseFloat(s.cash) || 0), 0);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-4 sm:p-6" style={{ fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-2 bg-emerald-500/15 rounded-xl"><DollarSign className="w-6 h-6 text-emerald-400" /></div>
          <div><h1 className="text-2xl font-bold">Tips Tracker</h1><p className="text-sm text-slate-400">Upload your Toast reports and schedule to track and forecast earnings</p></div>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-6">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4"><div className="flex items-center gap-2 text-slate-400 text-xs font-medium mb-1"><TrendingUp className="w-4 h-4" /> Total Tips</div><div className="text-2xl font-bold text-emerald-400">{fmt(total)}</div></div>
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4"><div className="flex items-center gap-2 text-slate-400 text-xs font-medium mb-1"><Clock className="w-4 h-4" /> Hours</div><div className="text-2xl font-bold">{totalHours.toFixed(1)}</div></div>
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4"><div className="flex items-center gap-2 text-slate-400 text-xs font-medium mb-1"><DollarSign className="w-4 h-4" /> True $/hr</div><div className="text-2xl font-bold">{totalHours > 0 ? fmt(avgHourly + BASE_WAGE) : "--"}</div></div>
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4"><div className="flex items-center gap-2 text-slate-400 text-xs font-medium mb-1"><Target className="w-4 h-4" /> Remaining</div><div className="text-2xl font-bold">{goal > 0 ? fmt(remaining) : "--"}</div></div>
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 col-span-2 lg:col-span-1"><div className="flex items-center gap-2 text-slate-400 text-xs font-medium mb-1"><CalIcon className="w-4 h-4" /> Days Left</div><div className="text-2xl font-bold">{goalDate ? (daysLeft > 0 ? daysLeft : "Past due") : "--"}</div></div>
        </div>

        {/* Import */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 mb-6">
          <h2 className="font-semibold mb-4 flex items-center gap-2"><Upload className="w-4 h-4 text-emerald-400" /> Import from Shift Reports</h2>
          <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => onFiles(e.target.files)} />
          <input ref={schedRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => onScheduleFiles(e.target.files)} />
          <div className="grid sm:grid-cols-2 gap-3">
            <button onClick={() => fileRef.current && fileRef.current.click()} disabled={processing} className="border-2 border-dashed border-slate-700 hover:border-emerald-500 rounded-xl py-6 px-3 flex flex-col items-center justify-center gap-2 text-slate-400 hover:text-emerald-400 transition-colors disabled:opacity-50">
              {processing ? <><Loader2 className="w-5 h-5 animate-spin" /><span className="text-xs">{procMsg}</span></> : <><DollarSign className="w-5 h-5" /><span className="text-sm font-medium">Upload shift reports</span><span className="text-[11px] text-slate-500">Toast tips screenshots</span></>}
            </button>
            <button onClick={() => schedRef.current && schedRef.current.click()} disabled={schedBusy} className="border-2 border-dashed border-slate-700 hover:border-sky-500 rounded-xl py-6 px-3 flex flex-col items-center justify-center gap-2 text-slate-400 hover:text-sky-400 transition-colors disabled:opacity-50">
              {schedBusy ? <><Loader2 className="w-5 h-5 animate-spin" /><span className="text-xs">{schedMsg}</span></> : <><CalendarClock className="w-5 h-5" /><span className="text-sm font-medium">Upload next week's schedule</span><span className="text-[11px] text-slate-500">Forecast your earnings</span></>}
            </button>
          </div>
          {staged.length > 0 && (
            <div className="mt-4">
              <div className="flex items-center justify-between mb-2"><p className="text-sm text-slate-300 font-medium">Review before importing</p><button onClick={() => setStaged([])} className="text-xs text-slate-500 hover:text-slate-300">Clear</button></div>
              <div className="space-y-2">
                {staged.map((r) => { const exists = r.date && entries[r.date]; return (
                  <div key={r.id} className="bg-slate-950 border border-slate-800 rounded-xl p-3">
                    {r.error && <p className="text-xs text-amber-400 mb-2">{r.error}</p>}
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 items-end">
                      <div className="col-span-2 sm:col-span-1"><label className="block text-[10px] text-slate-500 mb-0.5">Date</label><input type="date" value={r.date} onChange={(e) => updateStaged(r.id, "date", e.target.value)} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-sm [color-scheme:dark]" /></div>
                      <div><label className="block text-[10px] text-slate-500 mb-0.5">Start</label><input type="time" value={r.start} onChange={(e) => updateStaged(r.id, "start", e.target.value)} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-sm [color-scheme:dark]" /></div>
                      <div><label className="block text-[10px] text-slate-500 mb-0.5">End</label><input type="time" value={r.end} onChange={(e) => updateStaged(r.id, "end", e.target.value)} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-sm [color-scheme:dark]" /></div>
                      <div><label className="block text-[10px] text-slate-500 mb-0.5">Card tips</label><input type="number" value={r.tips} onChange={(e) => updateStaged(r.id, "tips", e.target.value)} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-sm" /></div>
                      <div className="col-span-2 sm:col-span-1 flex items-center gap-2">{exists ? <span className="text-[10px] text-amber-400">Adds to that day</span> : <span className="text-[10px] text-emerald-400">New</span>}<button onClick={() => removeStaged(r.id)} className="ml-auto p-1.5 hover:bg-slate-800 rounded-lg text-slate-500"><X className="w-4 h-4" /></button></div>
                    </div>
                  </div>
                ); })}
              </div>
              <button onClick={importStaged} className="mt-3 w-full bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold rounded-xl py-2.5 flex items-center justify-center gap-2"><Check className="w-4 h-4" /> Import {staged.length} shift{staged.length === 1 ? "" : "s"}</button>
              <p className="text-[10px] text-slate-500 mt-2">Reports only carry card tips. Add cash tips per day on the calendar.</p>
            </div>
          )}
        </div>

        {/* Forecast */}
        {forecast && fc && (
          <div className="bg-gradient-to-br from-sky-500/10 to-indigo-500/5 border border-sky-500/30 rounded-2xl p-5 mb-6">
            <div className="flex items-center justify-between mb-4 flex-wrap gap-2"><h2 className="font-semibold flex items-center gap-2"><Sparkles className="w-4 h-4 text-sky-400" /> Weekly Forecast</h2><button onClick={() => saveSchedule([])} className="text-xs text-slate-400 hover:text-slate-200">Clear schedule</button></div>
            {forecast.sampleN === 0 ? (
              <p className="text-sm text-slate-300">I read your schedule, but there's no past tip data yet to base a prediction on. Import a few shift reports and the forecast fills in automatically. Estimated amounts also appear in gray on the calendar.</p>
            ) : (
              <>
                <div className="grid sm:grid-cols-2 gap-3 mb-4">
                  <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-4"><p className="text-xs text-slate-400 mb-1">Predicted tips, scheduled shifts</p><p className="text-3xl font-bold text-sky-300">{fmt0(fc.schedTips)}</p><p className="text-xs text-slate-500 mt-1">range {fmt0(fc.schedLow)} to {fmt0(fc.schedHigh)} · {fc.schedHours.toFixed(1)} hrs</p><p className="text-xs text-slate-400 mt-1">Take-home incl. ${BASE_WAGE}/hr base: <span className="text-slate-200 font-medium">{fmt0(fc.schedTake)}</span></p></div>
                  <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-4"><p className="text-xs text-slate-400 mb-1">If you grab every open shift</p><p className="text-3xl font-bold text-emerald-300">{fmt0(fc.grandTips)}</p><p className="text-xs text-slate-500 mt-1">+{fmt0(fc.avTips)} from {forecast.available.length} open shift{forecast.available.length === 1 ? "" : "s"} · {(fc.schedHours + fc.avHours).toFixed(1)} hrs</p><p className="text-xs text-slate-400 mt-1">Take-home incl. base: <span className="text-slate-200 font-medium">{fmt0(fc.grandTake)}</span></p></div>
                </div>
                <p className="text-xs font-medium text-slate-400 mb-2">Scheduled shifts</p>
                <div className="space-y-1.5 mb-4">
                  {forecast.scheduled.map((s, i) => (
                    <div key={i} className="flex items-center gap-3 bg-slate-950/50 rounded-lg px-3 py-2 text-sm">
                      <div className="w-16 text-slate-300">{parseKey(s.date).toLocaleDateString("en-US", { weekday: "short", day: "numeric" })}</div>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium`} style={{ background: (s.part === "AM" ? AM_COLOR : PM_COLOR) + "30", color: s.part === "AM" ? AM_COLOR : PM_COLOR }}>{s.part}</span>
                      <div className="text-xs text-slate-500 flex-1">{s.start ? `${to12(s.start)} - ${to12(s.end)}` : "--"} <span className="text-slate-600">· {s.hours.toFixed(1)}h</span></div>
                      <div className="text-right">{s.pred ? <span className="font-semibold text-sky-300">{fmt0(s.pred.point)}</span> : <span className="text-slate-500">--</span>}{s.pred && <span className="text-[10px] text-slate-500 ml-1">({fmt0(s.pred.low)}-{fmt0(s.pred.high)})</span>}</div>
                    </div>
                  ))}
                </div>
                {forecast.available.length > 0 && (
                  <>
                    <p className="text-xs font-medium text-slate-400 mb-2">Open shifts you could pick up</p>
                    <div className="space-y-1.5">
                      {forecast.available.map((s, i) => (
                        <div key={i} className="flex items-center gap-3 bg-emerald-500/5 border border-emerald-500/20 rounded-lg px-3 py-2 text-sm">
                          <PlusCircle className="w-4 h-4 text-emerald-400 shrink-0" />
                          <div className="w-16 text-slate-300">{parseKey(s.date).toLocaleDateString("en-US", { weekday: "short", day: "numeric" })}</div>
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-medium" style={{ background: (s.part === "AM" ? AM_COLOR : PM_COLOR) + "30", color: s.part === "AM" ? AM_COLOR : PM_COLOR }}>{s.part}</span>
                          <div className="text-xs text-slate-500 flex-1">~{s.hours.toFixed(1)}h assumed</div>
                          <div className="text-right">{s.pred ? <span className="font-semibold text-emerald-300">+{fmt0(s.pred.point)}</span> : <span className="text-slate-500">--</span>}{s.pred && <span className="text-[10px] text-slate-500 ml-1">→ week {fmt0(fc.schedTips + s.pred.point)}</span>}</div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
                <p className="text-[10px] text-slate-500 mt-3">Based on {forecast.sampleN} past shift{forecast.sampleN === 1 ? "" : "s"}. Estimates show in gray on the calendar (AM top, PM bottom). Open-shift lengths are assumed from your history. Accuracy improves as you log more.</p>
              </>
            )}
          </div>
        )}

        <div className="grid lg:grid-cols-5 gap-6 mb-6">
          <div className="lg:col-span-2 space-y-6">
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
              <h2 className="font-semibold mb-4 flex items-center gap-2"><Target className="w-4 h-4 text-emerald-400" /> Set Your Goal</h2>
              <label className="block text-xs text-slate-400 mb-1">Goal amount</label>
              <div className="relative mb-4"><span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500">$</span><input type="number" inputMode="decimal" placeholder="0.00" value={goalAmount} onChange={(e) => { setGoalAmount(e.target.value); saveGoal(e.target.value, goalDate); }} className="w-full bg-slate-950 border border-slate-700 rounded-xl pl-7 pr-3 py-2.5 focus:outline-none focus:border-emerald-500" /></div>
              <label className="block text-xs text-slate-400 mb-1">Target date</label>
              <input type="date" value={goalDate} onChange={(e) => { setGoalDate(e.target.value); saveGoal(goalAmount, e.target.value); }} className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2.5 focus:outline-none focus:border-emerald-500 [color-scheme:dark]" />
              {goal > 0 && (<div className="mt-4"><div className="flex justify-between text-xs text-slate-400 mb-1"><span>Progress</span><span>{pct.toFixed(0)}%</span></div><div className="h-3 bg-slate-800 rounded-full overflow-hidden"><div className="h-full bg-gradient-to-r from-emerald-500 to-teal-400 rounded-full transition-all" style={{ width: `${pct}%` }} /></div></div>)}
            </div>
            <div className="bg-gradient-to-br from-emerald-500/10 to-teal-500/5 border border-emerald-500/30 rounded-2xl p-5">
              <div className="flex items-center justify-between mb-3"><h2 className="font-semibold flex items-center gap-2"><TrendingUp className="w-4 h-4 text-emerald-400" /> You Need To Make</h2><select value={rateUnit} onChange={(e) => setRateUnit(e.target.value)} className="bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-sm focus:outline-none focus:border-emerald-500"><option value="day">per day</option><option value="week">per week</option><option value="month">per month</option></select></div>
              {goal > 0 && goalDate && daysLeft > 0 && remaining > 0 ? (<><div className="text-4xl font-bold text-emerald-400">{fmt(required)}</div><p className="text-sm text-slate-400 mt-2">{fmt(remaining)} more across {daysLeft} day{daysLeft === 1 ? "" : "s"} until {parseKey(goalDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</p></>) : goal > 0 && remaining <= 0 ? <div className="text-xl font-bold text-emerald-400">Goal reached. Nice work.</div> : goalDate && daysLeft <= 0 ? <div className="text-slate-400 text-sm">Your target date has passed. Update it to recalculate.</div> : <div className="text-slate-400 text-sm">Set a goal amount and target date to see your required pace.</div>}
            </div>
          </div>

          <div className="lg:col-span-3 bg-slate-900 border border-slate-800 rounded-2xl p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-semibold flex items-center gap-2"><CalIcon className="w-4 h-4 text-emerald-400" /> Daily Earnings</h2>
              <div className="flex items-center gap-2"><button onClick={() => setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1))} className="p-1.5 hover:bg-slate-800 rounded-lg"><ChevronLeft className="w-4 h-4" /></button><span className="text-sm font-medium w-32 text-center">{MONTHS[viewMonth.getMonth()]} {viewMonth.getFullYear()}</span><button onClick={() => setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1))} className="p-1.5 hover:bg-slate-800 rounded-lg"><ChevronRight className="w-4 h-4" /></button></div>
            </div>
            <div className="flex items-center justify-between text-xs text-slate-500 mb-2">
              <span>{MONTHS[viewMonth.getMonth()]} total: <span className="text-slate-300 font-semibold">{fmt(monthTotal)}</span></span>
              <span className="flex items-center gap-2"><span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-emerald-400/70" />logged</span><span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-slate-600" />estimate</span></span>
            </div>
            <div className="grid grid-cols-7 gap-1 mb-1">{DOW.map((d) => <div key={d} className="text-center text-xs text-slate-500 font-medium py-1">{d}</div>)}</div>
            <div className="grid grid-cols-7 gap-1">
              {grid.map((date, i) => {
                if (!date) return <div key={i} />;
                const k = toKey(date); const e = entries[k]; const isToday = k === todayKey();
                const shifts = e ? e.shifts.map((s) => ({ ...s, part: partOf(s), total: (Number(s.tips) || 0) + (Number(s.cashTips) || 0) })) : [];
                const actAM = shifts.filter((s) => s.part === "AM").reduce((a, s) => a + s.total, 0);
                const actPM = shifts.filter((s) => s.part === "PM").reduce((a, s) => a + s.total, 0);
                const hasAM = shifts.some((s) => s.part === "AM"), hasPM = shifts.some((s) => s.part === "PM");
                const est = forecast && forecast.byDate[k];
                const estAM = est && est.AM ? est.AM.point : null;
                const estPM = est && est.PM ? est.PM.point : null;
                const amBg = hasAM && maxShift ? `rgba(16,185,129,${0.12 + Math.min(1, actAM / maxShift) * 0.5})` : "transparent";
                const pmBg = hasPM && maxShift ? `rgba(16,185,129,${0.12 + Math.min(1, actPM / maxShift) * 0.5})` : "transparent";
                return (
                  <button key={i} onClick={() => openDay(date)} className={`relative aspect-square rounded-lg border transition-all hover:border-emerald-500 overflow-hidden ${isToday ? "border-emerald-500/60" : "border-slate-800"}`} style={{ background: "rgba(15,23,42,0.5)" }}>
                    <div className="absolute inset-0 flex flex-col">
                      <div className="flex-1 flex items-center justify-center px-0.5 border-b border-slate-800/40" style={{ background: amBg }}>
                        {hasAM ? <span className="text-[8.5px] sm:text-[11px] font-semibold text-white leading-none">{fmt(actAM)}</span> : estAM != null ? <span className="text-[8.5px] sm:text-[11px] text-slate-500 leading-none">{fmt0(estAM)}</span> : null}
                      </div>
                      <div className="flex-1 flex items-center justify-center px-0.5" style={{ background: pmBg }}>
                        {hasPM ? <span className="text-[8.5px] sm:text-[11px] font-semibold text-white leading-none">{fmt(actPM)}</span> : estPM != null ? <span className="text-[8.5px] sm:text-[11px] text-slate-500 leading-none">{fmt0(estPM)}</span> : null}
                      </div>
                    </div>
                    <span className={`absolute top-0.5 left-1 text-[9px] leading-none z-10 ${isToday ? "text-emerald-300 font-bold" : "text-slate-400"}`}>{date.getDate()}</span>
                  </button>
                );
              })}
            </div>
            <div className="text-xs text-slate-500 mt-3">Top half = AM, bottom half = PM. Tap any day to log tips or mark a double.</div>
          </div>
        </div>

        {/* Chart: 14 buckets */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 mb-6">
          <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
            <h2 className="font-semibold flex items-center gap-2"><BarChart3 className="w-4 h-4 text-emerald-400" /> Best Days & Times</h2>
            <div className="flex bg-slate-950 border border-slate-700 rounded-lg p-0.5 text-xs"><button onClick={() => setChartMetric("tips")} className={`px-3 py-1 rounded-md ${chartMetric === "tips" ? "bg-emerald-500 text-slate-950 font-semibold" : "text-slate-400"}`}>Avg Tips</button><button onClick={() => setChartMetric("hourly")} className={`px-3 py-1 rounded-md ${chartMetric === "hourly" ? "bg-emerald-500 text-slate-950 font-semibold" : "text-slate-400"}`}>True $/hr</button></div>
          </div>
          {shiftList.length === 0 ? <p className="text-sm text-slate-500 py-8 text-center">Import or log some shifts to see your breakdown.</p> : (
            <>
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={byDayPart} margin={{ top: 4, right: 4, left: -16, bottom: 0 }} barCategoryGap="20%" barGap={2}>
                  <XAxis dataKey="label" tick={{ fill: "#94a3b8", fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: "#64748b", fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={(v) => "$" + Math.round(v)} />
                  <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #334155", borderRadius: 12 }} labelStyle={{ color: "#ffffff", fontWeight: 600 }} itemStyle={{ color: "#ffffff" }} cursor={{ fill: "rgba(255,255,255,0.04)" }} formatter={(v, name, p) => { const n = name === "AM" ? p.payload.amN : p.payload.pmN; return v > 0 ? [fmt(v) + metricSuffix + ` (${n} shift${n === 1 ? "" : "s"})`, name] : ["no shifts", name]; }} />
                  <Legend wrapperStyle={{ fontSize: 12, color: "#94a3b8" }} />
                  <Bar dataKey={amKey} name="AM" fill={AM_COLOR} radius={[5, 5, 0, 0]} />
                  <Bar dataKey={pmKey} name="PM" fill={PM_COLOR} radius={[5, 5, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
              <p className="text-[10px] text-slate-600 mt-1">14 buckets: each day split into AM (shifts starting before 3pm, ending ~5) and PM (starting ~5pm or later).</p>
            </>
          )}
        </div>

        {/* Log */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <h2 className="font-semibold mb-4 flex items-center gap-2"><Clock className="w-4 h-4 text-emerald-400" /> Shift Log</h2>
          {shiftList.length === 0 ? <p className="text-sm text-slate-500 py-4 text-center">No shifts logged yet.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-xs text-slate-500 border-b border-slate-800"><th className="py-2 pr-3 font-medium">Date</th><th className="py-2 pr-3 font-medium">Shift</th><th className="py-2 pr-3 font-medium">Hours</th><th className="py-2 pr-3 font-medium text-right">Card</th><th className="py-2 pr-3 font-medium text-right">Cash</th><th className="py-2 pr-3 font-medium text-right">Total</th><th className="py-2 pr-3 font-medium text-right">Hourly</th><th className="py-2 font-medium text-right">True $/hr</th></tr></thead>
                <tbody>
                  {shiftList.map((e, idx) => { const hourly = e.hours > 0 ? e.tips / e.hours : null; return (
                    <tr key={e.date + idx} className="border-b border-slate-800/60 hover:bg-slate-800/30 cursor-pointer" onClick={() => openDay(parseKey(e.date))}>
                      <td className="py-2.5 pr-3 whitespace-nowrap">{parseKey(e.date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}<span className="text-slate-500 text-xs ml-1">{DOW[parseKey(e.date).getDay()]}</span></td>
                      <td className="py-2.5 pr-3 text-slate-400 text-xs whitespace-nowrap">{e.start ? `${to12(e.start)} - ${to12(e.end)}` : "--"}<span className="ml-1.5 px-1.5 py-0.5 rounded text-[10px] font-medium" style={{ background: (e.part === "AM" ? AM_COLOR : PM_COLOR) + "30", color: e.part === "AM" ? AM_COLOR : PM_COLOR }}>{e.part}</span></td>
                      <td className="py-2.5 pr-3 text-slate-300">{e.hours > 0 ? e.hours.toFixed(2) : "--"}</td>
                      <td className="py-2.5 pr-3 text-right text-slate-300">{e.card ? fmt(e.card) : "--"}</td>
                      <td className="py-2.5 pr-3 text-right text-slate-300">{e.cash ? fmt(e.cash) : "--"}</td>
                      <td className="py-2.5 pr-3 text-right font-semibold text-emerald-400">{fmt(e.tips)}</td>
                      <td className="py-2.5 pr-3 text-right text-slate-300">{hourly != null ? fmt(hourly) : "--"}</td>
                      <td className="py-2.5 text-right font-medium text-white">{hourly != null ? fmt(hourly + BASE_WAGE) : "--"}</td>
                    </tr>
                  ); })}
                </tbody>
                <tfoot><tr className="text-sm font-semibold"><td className="py-3 pr-3">Total</td><td className="py-3 pr-3 text-slate-500 text-xs font-normal">{shiftList.length} shifts</td><td className="py-3 pr-3">{totalHours.toFixed(2)}</td><td className="py-3 pr-3 text-right text-slate-400">{fmt(shiftList.reduce((a, e) => a + e.card, 0))}</td><td className="py-3 pr-3 text-right text-slate-400">{fmt(shiftList.reduce((a, e) => a + e.cash, 0))}</td><td className="py-3 pr-3 text-right text-emerald-400">{fmt(total)}</td><td className="py-3 pr-3 text-right text-slate-300">{avgHourly > 0 ? fmt(avgHourly) : "--"}</td><td className="py-3 text-right text-white">{avgHourly > 0 ? fmt(avgHourly + BASE_WAGE) : "--"}</td></tr></tfoot>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Modal */}
      {selected && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50" onClick={() => setSelected(null)}>
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-5 w-full max-w-sm max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4"><h3 className="font-semibold">{parseKey(selected).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</h3><button onClick={() => setSelected(null)} className="p-1 hover:bg-slate-800 rounded-lg"><X className="w-5 h-5 text-slate-400" /></button></div>

            <button onClick={toggleDouble} className={`w-full mb-4 rounded-xl py-2 flex items-center justify-center gap-2 text-sm font-medium border ${editShifts.length === 2 ? "bg-violet-500/15 border-violet-500/40 text-violet-300" : "bg-slate-950 border-slate-700 text-slate-300 hover:border-violet-500"}`}>
              <Layers className="w-4 h-4" /> {editShifts.length === 2 ? "Double shift on (tap for single)" : "Double?"}
            </button>

            {editShifts.map((s, idx) => {
              const p = dayPart({ start: s.start });
              return (
                <div key={idx} className={editShifts.length === 2 ? "border border-slate-800 rounded-xl p-3 mb-3" : "mb-1"}>
                  {editShifts.length === 2 && <div className="flex items-center justify-between mb-2"><span className="text-xs font-semibold text-slate-300">Shift {idx + 1}</span>{p && <span className="px-1.5 py-0.5 rounded text-[10px] font-medium" style={{ background: (p === "AM" ? AM_COLOR : PM_COLOR) + "30", color: p === "AM" ? AM_COLOR : PM_COLOR }}>{p}</span>}</div>}
                  <label className="block text-xs text-slate-400 mb-1 flex items-center gap-1.5"><DollarSign className="w-3.5 h-3.5" /> Card tips</label>
                  <div className="relative mb-2"><span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500">$</span><input type="number" inputMode="decimal" placeholder="0.00" value={s.card} onChange={(e) => updateShift(idx, "card", e.target.value)} className="w-full bg-slate-950 border border-slate-700 rounded-xl pl-7 pr-3 py-2 focus:outline-none focus:border-emerald-500" /></div>
                  <label className="block text-xs text-slate-400 mb-1 flex items-center gap-1.5"><Banknote className="w-3.5 h-3.5" /> Cash tips</label>
                  <div className="relative mb-2"><span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500">$</span><input type="number" inputMode="decimal" placeholder="0.00" value={s.cash} onChange={(e) => updateShift(idx, "cash", e.target.value)} className="w-full bg-slate-950 border border-slate-700 rounded-xl pl-7 pr-3 py-2 focus:outline-none focus:border-emerald-500" /></div>
                  <div className="grid grid-cols-2 gap-2"><div><label className="block text-xs text-slate-400 mb-1">Clock in</label><input type="time" value={s.start} onChange={(e) => updateShift(idx, "start", e.target.value)} className="w-full bg-slate-950 border border-slate-700 rounded-xl px-2 py-2 focus:outline-none focus:border-emerald-500 [color-scheme:dark]" /></div><div><label className="block text-xs text-slate-400 mb-1">Clock out</label><input type="time" value={s.end} onChange={(e) => updateShift(idx, "end", e.target.value)} className="w-full bg-slate-950 border border-slate-700 rounded-xl px-2 py-2 focus:outline-none focus:border-emerald-500 [color-scheme:dark]" /></div></div>
                </div>
              );
            })}

            <div className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2.5 my-3 flex items-center justify-between text-sm"><span className="text-slate-400">Day total</span><span className="font-semibold text-emerald-400">{fmt(editTotal)}</span></div>
            <div className="flex gap-2"><button onClick={commitDay} className="flex-1 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold rounded-xl py-2.5 flex items-center justify-center gap-2"><Plus className="w-4 h-4" /> Save</button>{entries[selected] != null && <button onClick={removeDay} className="px-4 bg-slate-800 hover:bg-slate-700 rounded-xl py-2.5 text-slate-300"><Trash2 className="w-4 h-4" /></button>}</div>
          </div>
        </div>
      )}
    </div>
  );
}
