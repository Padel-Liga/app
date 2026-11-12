// Einmalige Test-Vorschau der 12-Uhr-Push – nur an Michael (teryeoc8).
import admin from "firebase-admin";
const SA = process.env.FIREBASE_SA, LIGA = process.env.LIGA_CODE;
const APP_URL = "https://padel-liga.github.io/app/";
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(SA)) });
const db = admin.firestore();
const q = await db.collection(`ligen/${LIGA}/members`).get();
const tokens = [...new Set(q.docs.map(d=>d.data()).filter(m => m.pid==="teryeoc8" && m.pushToken && m.active!==false).map(m=>m.pushToken))];
console.log("Geräte von Michael:", tokens.length);
const msgs = [
  {title:"🎾 Heute ist Matchday! 19:30 Uhr", body:"Michael, Henne, Marc & Jonas\n🔥 Jonas: 2 Siege in Folge · 🥊 Michael vs. Marc 3:2 · 🤝 Michael & Marc 3/3 als Team"},
  {title:"🎾 Heute 19:30 Uhr · noch 2 Plätze frei!", body:"Dabei sind Michael & Henne. Sven und Marc haben „Vielleicht“ gesagt. Kannst du?"}
];
for(const m of msgs){
  if(!tokens.length) break;
  const r = await admin.messaging().sendEachForMulticast({tokens, notification:m,
    webpush:{notification:{icon:APP_URL+"icon-192.png", badge:APP_URL+"icon-192.png"}, fcmOptions:{link:APP_URL}}});
  console.log(m.title, "→ ok:", r.successCount, "fehler:", r.failureCount, r.responses.map(x=>x.error?.code||"").join(" "));
  await new Promise(s=>setTimeout(s,3000));
}
