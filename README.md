# Padel-Liga

Web-App für unsere Padel-Liga: Spieltage im Americano-Format (4 Spieler, 3 Runden à 1 Satz, ausgeloste Extra-Runden), Tabelle nach Siegquote und Kasse für Platzkosten und Zahlungen.

- **App:** https://padel-liga.github.io/app/
- **Daten:** Firebase Firestore (Projekt `padel-liga-d9788`), Anmeldung mit Google
- **Zugriff:** nur die in den Firestore-Regeln eingetragenen Google-Konten

Die Firebase-Konfiguration in `index.html` ist kein Geheimnis. Geschützt werden die Daten durch die Firestore-Sicherheitsregeln.
