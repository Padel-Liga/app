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
const [members, votes, matchdays, ledger, requests] = await Promise.all(["members","votes","matchdays","ledger","requests"].map(all));
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
  if(ms.length && ms.every(x => result(x).played)) continue;
  const parts = md.participants || [];
  queue(`miss:${md.id}`, "📝 Ergebnisse fehlen", `Für den Spieltag am ${s.label} fehlen noch Ergebnisse.`, forType("missing", mm => parts.includes(mm.pid)));
}
// 6) Zahlung wartet auf Bestätigung (an Daniel)
for(const e of ledger.filter(e => e.status==="pending"))
  queue(`conf:${e.id}`, "💶 Zahlung bestätigen", `${pname(e.from)} hat ${eur(Number(e.amount)||0)} gesendet. Bitte prüfen und bestätigen.`, forType("confirm", m => m.pid && m.pid===(e.to||bank)));
// 7) Neues Gerät
for(const r of requests)
  queue(`req:${r.id}`, "📱 Neues Gerät", `${r.name || "Jemand"} möchte der Liga beitreten.`, forType("devices"));
// Test-Nachrichten
const tests = members.filter(m => m.pushTest && m.pushToken && m.active !== false);
for(const m of tests) outbox.push({key:null, title:"🔔 Test", body:"Push-Benachrichtigungen funktionieren!", to:[m], test:true});

/* ---------- Versand ---------- */
let sentCount = 0;
for(const msg of outbox){
  const tokens = [...new Set(msg.to.map(m => m.pushToken))];
  console.log("Sende:", msg.key || "test", "|", msg.title, "→", msg.to.map(m=>m.name||m.pid).join(", "));
  if(DRY){ console.log("[DRY]", msg.key, msg.title, "|", msg.body, "→", msg.to.map(m=>m.name||m.pid).join(", ")); }
  else {
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
}
// alte Einträge (älter als 45 Tage) aufräumen
for(const k of Object.keys(sent)) if(Date.now() - sent[k] > 45*86400000) delete sent[k];
// alte Spielstatus-Einträge aufräumen
const keep = k => k >= new Date(Date.now()-14*86400000).toISOString().slice(0,10);
for(const obj of [state.fullState||{}, state.fullCount||{}]) for(const k of Object.keys(obj)) if(!keep(k)) delete obj[k];
if(!DRY) await stateRef.set({sent, fullState: state.fullState||{}, fullCount: state.fullCount||{}, lastRun: Date.now()});
console.log(`Fertig: ${outbox.length} Nachricht(en), ${sentCount} Zustellung(en).`);
