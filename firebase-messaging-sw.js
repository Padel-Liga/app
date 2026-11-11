/* Service Worker für Push-Benachrichtigungen (Firebase Cloud Messaging).
   Benachrichtigungen mit "notification"-Inhalt zeigt Firebase automatisch an;
   ein Tipp darauf öffnet die App (Link aus fcmOptions). */
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyClAD0L79joq8W7bQiMyb-uFIYK_IKBmhc",
  authDomain: "padel-liga-d9788.firebaseapp.com",
  projectId: "padel-liga-d9788",
  storageBucket: "padel-liga-d9788.firebasestorage.app",
  messagingSenderId: "465446473705",
  appId: "1:465446473705:web:d0ca6588a9fda78e968578"
});
const messaging = firebase.messaging();

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.FCM_MSG && event.notification.data.FCM_MSG.fcmOptions && event.notification.data.FCM_MSG.fcmOptions.link) || "./";
  event.waitUntil(clients.matchAll({type:"window", includeUncontrolled:true}).then(list => {
    for(const c of list){ if("focus" in c) return c.focus(); }
    return clients.openWindow(url);
  }));
});
