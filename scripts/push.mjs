// Versand der Push-Benachrichtigungen für die Padel-Liga.
// Läuft per GitHub Actions alle paar Minuten, liest die Daten aus Firestore
// und schickt neue Benachrichtigungen über Firebase Cloud Messaging.
// Bereits gesendete Nachrichten werden in ligen/<code>/system/push vermerkt.
import admin from "firebase-admin";

const SA = process.env.FIREBASE_SA;
const LIGA = process.env.LIGA_CODE;
const APP_URL = "https://padel-liga.github.io/app/";
const DRY = process.env.DRY_RUN === "1";
if(!SA || !LIGA){ console.log("FIREBASE_SA oder LIGA_CODE fehlt – nichts zu tun."); process.exit(0); }

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(SA)) });
const db = admin.firestore();
const base = `ligen/${LIGA}`;

/* ---------- Zeit in Europe/Berlin ---------- */
const TZ = "Europe/Berlin";
const WD = ["So","Mo","Di","Mi","Do","Fr","Sa"];
function berlinParts(d){
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA",{timeZone:TZ, year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", hourCycle:"h23", weekday:"short"}).formatToParts(d).map(x=>[x.type,x.value]));
  return {y:+p.year, m:+p.month, d:+p.day, hh:+p.hour, mm:+p.minute, wd:["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(p.weekday)};
}
function offsetMin(d){ const p = berlinParts(d); return (Date.UTC(p.y,p.m-1,p.d,p.hh,p.mm) - Math.floor(d.getTime()/60000)*60000)/60000; }
function berlinTime(y,m,d,hh,mm){ // lokale Berliner Zeit → Date
  const guess = new Date(Date.UTC(y,m-1,d,hh,mm)); const off = offsetMin(guess);
  const t = new Date(guess.getTime() - off*60000); const off2 = offsetMin(t);
  return off2===off ? t : new Date(guess.getTime() - off2*60000);
}
const iso = (y,m,d) => `${y}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
function sched(cfg){
  const days = Array.isArray(cfg.playDays) && cfg.playDays.length ? cfg.playDays : [2,4];
  const ok = t => /^\d{1,2}:\d{2}$/.test(t||"");
  return {days, start: ok(cfg.startTime)?cfg.startTime:"19:30", end: ok(cfg.endTime)?cfg.endTime:"21:00"};
}
function sessionOn(dateUtcNoon, sc){
  const p = berlinParts(dateUtcNoon);
  const [sh,sm] = sc.start.split(":").map(Number), [eh,em] = sc.end.split(":").map(Number);
  const start = berlinTime(p.y,p.m,p.d,sh,sm); let end = berlinTime(p.y,p.m,p.d,eh,em);
  if(end <= start) end = new Date(end.getTime()+86400000);
  return {start, end, key: iso(p.y,p.m,p.d), wd:p.wd, label:`${WD[p.wd]}, ${String(p.d).padStart(2,"0")}.${String(p.m).padStart(2,"0")}.`};
}
function nextSession(now, sc){
  for(let i=0;i<15;i++){
    const d = new Date(now.getTime() + i*86400000); const p = berlinParts(d);
    if(!sc.days.includes(p.wd)) continue;
    const s = sessionOn(new Date(Date.UTC(p.y,p.m-1,p.d,12)), sc);
    if(now < s.end) return {...s, live: now >= s.start};
  }
  return null;
}

/* ---------- Daten ---------- */
async function all(coll){ const q = await db.collection(`${base}/${coll}`).get(); return q.docs.map(d => ({...d.data(), id:d.id})); }
const cfgSnap = await db.doc(`${base}/league/config`).get();
if(!cfgSnap.exists){ console.log("Keine Liga-Konfiguration."); process.exit(0); }
const cfg = cfgSnap.data();
const [members, votes, matchdays, ledger, requests, results, broadcasts, surveys, comments] = await Promise.all(["members","votes","matchdays","ledger","requests","results","broadcasts","surveys","comments"].map(all));
const resById = Object.fromEntries(results.map(r => [r.id, r]));
const stateRef = db.doc(`${base}/system/push`);
const state = (await stateRef.get()).data() || {};
const sent = state.sent || {};

const players = cfg.players || [], guests = cfg.guests || [];
const pname = id => players.find(p=>p.id===id)?.name || guests.find(g=>g.id===id)?.name || "Jemand";
const valid = id => players.some(p=>p.id===id) || guests.some(g=>g.id===id);
const bank = (cfg.paypalOwner && players.some(p=>p.id===cfg.paypalOwner)) ? cfg.paypalOwner : (cfg.guestCashier || null);
const sc = sched(cfg);
const now = new Date();
const eur = n => new Intl.NumberFormat("de-DE",{style:"currency",currency:"EUR"}).format(n);

function pollFor(key){
  const vs = votes.filter(v => v.key===key && valid(v.pid));
  const yes = vs.filter(v=>v.s==="yes").sort((a,b)=>(a.t||0)-(b.t||0)).map(v=>v.pid);
  return {yes, play: yes.slice(0,4)};
}
const result = m => { let sa=0,sb=0,n=0; for(const s of (m.sets||[])){ if(s?.a==null||s?.b==null) continue; n++; if(s.a>s.b) sa++; else if(s.b>s.a) sb++; } return {played:n>0}; };

/* ---------- Statistik für die Matchday-Fakten ---------- */
const namesList = (ids, and="&") => { const n = ids.map(pname); return n.length<=1 ? (n[0]||"") : n.slice(0,-1).join(", ") + ` ${and} ` + n[n.length-1]; };
function playedMatches(){
  const out = [];
  for(const md of [...matchdays].sort((a,b)=>(a.date||"").localeCompare(b.date||"") || (a.createdAt||0)-(b.createdAt||0)))
    for(const m of (md.matches||[])){
      const r = resById[`${md.id}__${m.id}`];
      const sets = r ? (r.status==="confirmed" ? (r.sets||[]) : []) : (m.sets||[]);
      let sa=0,sb=0,ga=0,gb=0,n=0;
      for(const x of sets){ const a=Number(x?.a), b=Number(x?.b); if(x?.a==null||x?.b==null||!(a>=0&&b>=0)) continue; n++; ga+=a; gb+=b; if(a>b) sa++; else if(b>a) sb++; }
      if(!n) continue;
      const w = sa>sb ? "a" : sb>sa ? "b" : ga>gb ? "a" : gb>ga ? "b" : "d";
      out.push({a:m.a||[], b:m.b||[], w});
    }
  return out;
}
function matchFacts(play){
  const ms = playedMatches(); const F = [];
  const side = (m,id) => m.a.includes(id) ? "a" : m.b.includes(id) ? "b" : null;
  for(const id of play){
    const xs = ms.filter(m => side(m,id)).map(m => m.w==="d" ? "U" : m.w===side(m,id) ? "S" : "N");
    if(!xs.length) { if(guests.some(g=>g.id===id)) F.push({w:6, t:`👋 ${pname(id)}: erstes Match`}); continue; }
    const last = xs[xs.length-1]; let n=0; for(let k=xs.length-1;k>=0&&xs[k]===last;k--) n++;
    if(last==="S" && n>=2) F.push({w:9+n/100, t:`🔥 ${pname(id)}: ${n} Siege in Folge`});
    if(last==="N" && n>=2) F.push({w:7+n/100, t:`🧊 ${pname(id)}: ${n} Niederlagen in Folge`});
  }
  let best=null, duo=null;
  for(let i=0;i<play.length;i++) for(let j=i+1;j<play.length;j++){
    const a=play[i], b=play[j]; const vs={sp:0,a:0,b:0}, tog={sp:0,s:0};
    for(const m of ms){ const sa=side(m,a), sb=side(m,b); if(!sa||!sb) continue;
      if(sa===sb){ tog.sp++; if(m.w===sa) tog.s++; } else { vs.sp++; if(m.w===sa) vs.a++; else if(m.w===sb) vs.b++; } }
    if(vs.sp>=2 && (!best || vs.sp>best.vs.sp)) best={a,b,vs};
    if(tog.sp>=2 && tog.s/tog.sp>=.75 && (!duo || tog.s>duo.tog.s)) duo={a,b,tog};
  }
  if(best){ const [x,y] = best.vs.a>=best.vs.b ? [best.a,best.b] : [best.b,best.a]; F.push({w:8, t:`🥊 ${pname(x)} vs. ${pname(y)} ${Math.max(best.vs.a,best.vs.b)}:${Math.min(best.vs.a,best.vs.b)}`}); }
  if(duo) F.push({w:7, t:`🤝 ${pname(duo.a)} & ${pname(duo.b)} ${duo.tog.s}/${duo.tog.sp} als Team`});
  return F.sort((p,q)=>q.w-p.w).slice(0,3).map(f=>f.t);
}

/* ---------- Empfänger ---------- */
const active = members.filter(m => m.active !== false && m.pushToken);
const wants = (m, type) => (m.pushPrefs || {})[type] !== false;
const forType = (type, filter = () => true) => active.filter(m => wants(m, type) && filter(m));

const outbox = []; // {key, title, body, to:[member]}
function queue(key, title, body, to){ if(sent[key] || !to.length) { if(!to.length && !sent[key]) sent[key] = Date.now(); return; } outbox.push({key, title, body, to}); }

const ns = nextSession(now, sc);
if(ns){
  const P = pollFor(ns.key);
  // 1) Neue Abstimmung offen
  queue(`poll:${ns.key}`, "🗳️ Neue Abstimmung", `${ns.label} ${sc.start} Uhr – bist du dabei?`, forType("poll", m => players.some(p=>p.id===m.pid)));
  // 2) Spiel steht / nicht mehr komplett (kann mehrmals hin und her wechseln)
  const fs = state.fullState || {}; const was = !!fs[ns.key]; const isFull = P.play.length >= 4;
  const n = (state.fullCount||{})[ns.key] || 0;
  if(isFull && !was){
    queue(`full:${ns.key}:${n}`, "✅ Spiel steht", `${ns.label} ${sc.start} Uhr: ${P.play.map(pname).join(", ")}`, forType("full"));
    fs[ns.key] = true;
  } else if(!isFull && was){
    const miss = 4 - P.play.length;
    queue(`unfull:${ns.key}:${n}`, "⚠️ Spiel nicht mehr komplett", `${ns.label} ${sc.start} Uhr: Es ${miss===1?"fehlt 1 Spieler":`fehlen ${miss} Spieler`}. Kannst du einspringen?`, forType("unfull"));
    fs[ns.key] = false; state.fullCount = {...(state.fullCount||{}), [ns.key]: n+1};
  }
  state.fullState = fs;
  // 3) Nachgerückt
  for(const n of votes.filter(v => v.key===ns.key && v.type==="moveup" && P.play.includes(v.in)))
    queue(`moveup:${n.id}`, "↑ Du bist nachgerückt", `Du spielst ${ns.label} um ${sc.start} Uhr (für ${pname(n.out)}).`, forType("moveup", m => m.pid===n.in));
  // 3b) Matchday-Fakten um 12 Uhr am Spieltag (einmal pro Spieltag)
  const bp = berlinParts(now);
  if(ns.key === iso(bp.y,bp.m,bp.d) && bp.hh >= 12 && now < ns.start){
    const md = matchdays.find(x => x.date===ns.key);
    const play = (md?.participants?.length ? md.participants : P.play).slice(0,4);
    if(play.length >= 4){
      const facts = matchFacts(play);
      queue(`noon:${ns.key}`, `🎾 Heute ist Matchday! ${sc.start} Uhr`, `${namesList(play)}${facts.length ? "\n" + facts.join(" · ") : ""}`, forType("noon"));
    } else {
      const free = 4 - play.length;
      const maybe = votes.filter(v => v.key===ns.key && v.s==="maybe" && valid(v.pid)).map(v=>v.pid);
      const body = (play.length ? `Dabei ${play.length===1?"ist":"sind"} ${namesList(play)}.` : "Noch hat niemand zugesagt.")
        + (maybe.length ? ` ${namesList(maybe, "und")} ${maybe.length===1?"hat":"haben"} „Vielleicht“ gesagt.` : "") + " Kannst du?";
      queue(`noon:${ns.key}`, `🎾 Heute ${sc.start} Uhr · noch ${free===1?"1 Platz":free+" Plätze"} frei!`, body, forType("noon", m => !P.yes.includes(m.pid)));
    }
  }
  // 4) Erinnerung 1 Stunde vorher
  const mins = (ns.start - now)/60000;
  if(mins <= 65 && mins > 0){
    const who = P.play.length ? P.play : P.yes;
    queue(`rem:${ns.key}`, "⏰ Gleich geht's los", `Padel heute um ${sc.start} Uhr${P.play.length>=4 ? ": " + P.play.map(pname).join(", ") : ""}.`, forType("reminder", m => who.includes(m.pid)));
  }
}
// 5) Ergebnisse fehlen (ab 30 Min nach Spielende, höchstens 3 Tage zurück)
for(const md of matchdays){
  if(!md.date) continue;
  const [y,m,d] = md.date.split("-").map(Number);
  const s = sessionOn(new Date(Date.UTC(y,m-1,d,12)), sc);
  const since = (now - s.end)/60000;
  if(since < 30 || since > 3*24*60) continue;
  const ms = md.matches || [];
  const done = x => { const r = resById[`${md.id}__${x.id}`]; return r ? r.status==="confirmed" : result(x).played; };
  if(ms.length && ms.every(done)) continue;
  const parts = md.participants || [];
  queue(`miss:${md.id}`, "📝 Ergebnisse fehlen", `Für den Spieltag am ${s.label} fehlen noch Ergebnisse.`, forType("missing", mm => parts.includes(mm.pid)));
}
// 5b) Ergebnis wartet auf Bestätigung durch das andere Team
const hasDevice = pid => active.some(m => m.pid===pid) || members.some(m => m.pid===pid && m.active!==false);
for(const r of results.filter(r => r.status==="proposed")){
  const md = matchdays.find(x => x.id===r.md); const m = md?.matches?.find(x => x.id===r.match); if(!m) continue;
  const own = r.side==="a" ? (m.a||[]) : r.side==="b" ? (m.b||[]) : [];
  const other = r.side==="a" ? (m.b||[]) : r.side==="b" ? (m.a||[]) : [];
  let who = other.filter(hasDevice);
  if(!who.length) who = players.map(p=>p.id).filter(id => !own.includes(id) && id!==r.by);
  const sc = (r.sets||[]).map(s => `${s.a}:${s.b}`).join(" ");
  queue(`res:${r.id}:${r.at||0}`, "🎾 Ergebnis bestätigen", `${pname(r.by)} hat ${(m.a||[]).map(pname).join(" & ")} ${sc} ${(m.b||[]).map(pname).join(" & ")} eingetragen. Stimmt das?`, forType("resconf", mm => who.includes(mm.pid)));
}
// 6) Zahlung wartet auf Bestätigung (an Daniel)
for(const e of ledger.filter(e => e.status==="pending"))
  queue(`conf:${e.id}`, "💶 Zahlung bestätigen", `${pname(e.from)} hat ${eur(Number(e.amount)||0)} gesendet. Bitte prüfen und bestätigen.`, forType("confirm", m => m.pid && m.pid===(e.to||bank)));
// 7) Neues Gerät
for(const r of requests)
  queue(`req:${r.id}`, "📱 Neues Gerät", `${r.name || "Jemand"} möchte der Liga beitreten.`, forType("devices"));
// Mitteilungen von Michael
const ADMIN_PIDS = ["teryeoc8"];
for(const b of broadcasts.filter(b => b.status==="queued" && ADMIN_PIDS.includes(b.by) && !((b.sendAt||0) > Date.now()))){
  const toOk = m => b.to==="all" ? true : b.to==="players" ? players.some(p=>p.id===m.pid) : Array.isArray(b.to) && b.to.includes(m.pid);
  const rec = forType("news", m => toOk(m) && m.pid !== b.by);
  outbox.push({key:`bc:${b.id}`, title: "📣 " + (b.title || `Nachricht von ${pname(b.by)}`), body: b.body, to: rec, broadcast: b.id});
}
// Neue Umfrage (an alle außer dem Ersteller, nur solange sie läuft)
for(const s of surveys.filter(s => (s.until||0) > Date.now() && Date.now() - (s.at||0) < 86400000))
  queue(`sv:${s.id}`, `📊 Neue Umfrage von ${pname(s.by)}`, `${s.q}\n${(s.opts||[]).join(" · ")}`, forType("survey", m => m.pid !== s.by));
// Neue Kommentare (nur frische, an alle außer dem Verfasser)
for(const c of comments.filter(c => typeof c.text==="string" && Date.now() - (c.at||0) < 3600000)){
  const where = (c.t||"").startsWith("sv:") ? `Umfrage „${(surveys.find(s => "sv:"+s.id===c.t)?.q || "").slice(0,40)}“` : "Abstimmung";
  queue(`cm:${c.id}`, `💬 ${pname(c.pid)} · ${where}`, c.text.slice(0,140), forType("comment", m => m.pid !== c.pid));
}
// Test-Nachrichten
const tests = members.filter(m => m.pushTest && m.pushToken && m.active !== false);
for(const m of tests) outbox.push({key:null, title:"🔔 Test", body:"Push-Benachrichtigungen funktionieren!", to:[m], test:true});

/* ---------- Versand ---------- */
let sentCount = 0;
for(const msg of outbox){
  const tokens = [...new Set(msg.to.map(m => m.pushToken))];
  console.log("Sende:", msg.key || "test", "|", msg.title, "→", msg.to.map(m=>m.name||m.pid).join(", "));
  if(DRY){ console.log("[DRY]", msg.key, msg.title, "|", msg.body, "→", msg.to.map(m=>m.name||m.pid).join(", ")); }
  else if(tokens.length) {
    const res = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title: msg.title, body: msg.body },
      webpush: { notification: { icon: APP_URL + "icon-192.png", badge: APP_URL + "icon-192.png" }, fcmOptions: { link: APP_URL } }
    });
    res.responses.forEach((r, i) => {
      if(r.success) { sentCount++; return; }
      const code = r.error?.code || "";
      console.log("Fehler:", code, msg.key);
      if(code.includes("registration-token-not-registered") || code.includes("invalid-registration-token") || code.includes("invalid-argument")){
        const mem = msg.to.find(m => m.pushToken === tokens[i]); if(mem) db.doc(`${base}/members/${mem.id}`).update({pushToken: null}).catch(()=>{});
      }
    });
  }
  if(msg.key) sent[msg.key] = Date.now();
  if(msg.test && !DRY) for(const m of msg.to) await db.doc(`${base}/members/${m.id}`).update({pushTest: false});
  if(msg.broadcast && !DRY) await db.doc(`${base}/broadcasts/${msg.broadcast}`).update({status:"sent", sentAt: Date.now(), count: msg.to.length});
}
// alte Einträge (älter als 45 Tage) aufräumen
for(const k of Object.keys(sent)) if(Date.now() - sent[k] > 45*86400000) delete sent[k];
// alte Spielstatus-Einträge aufräumen
const keep = k => k >= new Date(Date.now()-14*86400000).toISOString().slice(0,10);
for(const obj of [state.fullState||{}, state.fullCount||{}]) for(const k of Object.keys(obj)) if(!keep(k)) delete obj[k];
if(!DRY) await stateRef.set({sent, fullState: state.fullState||{}, fullCount: state.fullCount||{}, lastRun: Date.now()});
console.log(`Fertig: ${outbox.length} Nachricht(en), ${sentCount} Zustellung(en).`);
