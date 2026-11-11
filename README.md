# Padel-Liga

Web-App für unsere Padel-Liga: Spieltage im Americano-Format (4 Spieler, 3 Runden à 1 Satz, ausgeloste Extra-Runden), Tabelle nach Siegquote und Kasse für Platzkosten und Zahlungen.

- **App:** https://padel-liga.github.io/app/
- **Daten:** Firebase Firestore (Projekt `padel-liga-d9788`)
- **Zugriff:** über den persönlichen Liga-Link (`?liga=…`). Der Code steht nicht in diesem Repository.

Die Firebase-Konfiguration in `index.html` ist kein Geheimnis. Die Daten liegen unter einem geheimen Liga-Code, den nur der Liga-Link enthält.
