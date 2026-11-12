# Schritt-für-Schritt-Anleitung (Windows)

Diese Anleitung bringt dich in ca. 20 Minuten vom Download bis zum laufenden Bot.
Du brauchst **keine Programmierkenntnisse** und musst **keine Dateien von Hand bearbeiten**.

## ✅ Checkliste: Was du brauchst

- [ ] Windows-PC mit Internet
- [ ] Phantom-Wallet (Browser-Erweiterung oder App), in der du dich anmelden kannst
- [ ] Für später (Live-Handel): ca. **0,2–0,3 SOL**, die du im schlimmsten Fall verlieren kannst

## Die Dateien im Bot-Ordner

| Datei (Doppelklick) | Was sie tut |
|---|---|
| `1_INSTALLIEREN.bat` | Einmalig: installiert alles und macht einen Selbsttest |
| `2_EINRICHTEN.bat` | Assistent: Phantom-Konto verbinden, Live-Handel ein- und ausschalten |
| `3_BOT_STARTEN.bat` | Startet den Bot (Fenster offen lassen!) |
| `STATUS_ANZEIGEN.bat` | Guthaben, offene Positionen, Gewinn/Verlust |
| `TRENDS_ANZEIGEN.bat` | Zeigt, welche Trends (z. B. GTA 6) und passenden Coins der Bot gerade findet (kauft nichts) |
| `FRUEHPHASE_ANSEHEN.bat` | Zeigt 30 Minuten live, welche **ganz neuen** Coins der Bot sieht und wie er ihr Potenzial bewertet (kauft nichts) |
| `AUSWERTUNG.bat` | Zeigt, ob Coins mit hohem Potenzial-Score später wirklich gestiegen sind |
| `WALLET_PRUEFEN.bat` | Prüft die Verbindung zum Bot-Konto (handelt nicht) |
| `KAEUFE_PAUSIEREN.bat` | Bot kauft nichts Neues mehr, verwaltet aber offene Positionen weiter |
| `KAEUFE_FORTSETZEN.bat` | Hebt die Pause auf |
| `NOTVERKAUF.bat` | Verkauft sofort alle offenen Positionen |

---

## TEIL 1: Installation (einmalig)

### Schritt 1: Node.js installieren
1. Öffne **https://nodejs.org**.
2. Klicke auf den Download mit **„LTS“**.
3. Starte die heruntergeladene Datei und klicke immer auf **„Weiter“** bzw. **„Next“**, dann auf **„Fertigstellen“**.

### Schritt 2: Bot herunterladen
1. Öffne **https://github.com/Kalle3012/Meme-coin-Trader-** und melde dich bei GitHub an.
2. Klicke auf den grünen Knopf **„Code“** und dann auf **„Download ZIP“**.
3. Öffne den Ordner *Downloads*, klicke mit der rechten Maustaste auf die ZIP-Datei und wähle **„Alle extrahieren…“**.
4. Gib als Ziel z. B. `C:\Bots` ein und klicke auf **„Extrahieren“**.
5. Öffne den entpackten Ordner. Darin müssen die Dateien `1_INSTALLIEREN.bat`, `README.md` usw. liegen.
   Liegt dort nur ein weiterer Ordner, öffne diesen.

### Schritt 3: Installieren
1. Doppelklicke auf **`1_INSTALLIEREN.bat`**.
2. Falls Windows „Der Computer wurde durch Windows geschützt“ anzeigt, klicke auf **„Weitere Informationen“** und dann auf **„Trotzdem ausführen“**.
3. Warte, bis **„FERTIG“** erscheint. Das dauert 1–2 Minuten. Drücke dann eine beliebige Taste.

---

## TEIL 2: Testen ohne Geld (mindestens 3–7 Tage)

### Schritt 4: Bot im Papiermodus starten
1. Doppelklicke auf **`3_BOT_STARTEN.bat`**.
2. Im Fenster muss stehen: **„Modus: PAPIER (simuliert, kein echtes Geld)“**.
3. **Fenster offen lassen.** Wenn du es schließt, stoppt der Bot.
4. **Energiesparmodus ausschalten**, sonst schläft der Bot mit dem PC ein:
   Start → Einstellungen → System → **Netzbetrieb und Energie** → Bildschirm und Energiesparmodus → „Gerät in den Energiesparmodus versetzen nach“ auf **„Nie“** stellen.

> Der Bot kauft oft **stundenlang nichts**. Das ist richtig so: Die meisten Meme-Coins fallen
> durch die Sicherheitsprüfungen. Im Fenster siehst du jede Minute eine Zeile „Scan: …“.

### Schritt 5: Ergebnisse ansehen
- Doppelklicke jederzeit auf **`STATUS_ANZEIGEN.bat`** (der Bot darf dabei weiterlaufen).
- Alle Trades stehen in `data\trades.csv`. Öffne die Datei mit Excel.

### Schritt 6: Entscheiden
Lass den Bot **mindestens 3–7 Tage** laufen und öffne dann `STATUS_ANZEIGEN.bat`:
- **„Gesamt: … Ergebnis“ positiv** → Teil 3 ist möglich, mit kleinen Beträgen.
- **negativ** → **nicht** live gehen. Schick Claude die Datei `data\trades.csv`, um die Strategie anzupassen.

Der Papiermodus ist etwas **zu optimistisch**: Echte Trades kosten zusätzlich Slippage und Gebühren.

---

## TEIL 3: Phantom verbinden und live handeln

### Schritt 7: Separates Bot-Konto in Phantom anlegen
1. Öffne Phantom und klicke **oben links auf dein Konto-Symbol**.
2. Klicke auf **„Konto hinzufügen“** und dann auf **„Neues Konto erstellen“**.
3. Gib ihm den Namen **„Trading-Bot“**.

### Schritt 8: Bot-Konto aufladen
1. Wechsle in Phantom auf dein **Hauptkonto**.
2. Klicke auf **„Senden“**, wähle **SOL** und als Empfänger dein Konto **„Trading-Bot“**.
3. Sende z. B. **0,2–0,3 SOL**. Das ist das Maximum, das du verlieren kannst.

### Schritt 9: Den Assistenten starten
1. **Beende den Bot**, falls er läuft: Klicke in sein Fenster und drücke **Strg+C**. Fragt Windows „Batchvorgang abbrechen (J/N)?“, antworte mit **N**.
2. Doppelklicke auf **`2_EINRICHTEN.bat`**.
3. Tippe **`1`** und Enter: **Phantom-Bot-Konto verbinden**.
4. **Adresse:** Wechsle in Phantom auf das Konto „Trading-Bot“ und klicke auf die Adresse, um sie zu kopieren. Füge sie im Fenster ein (Rechtsklick oder Strg+V) und drücke Enter.
5. **Privater Schlüssel:** In Phantom → ⚙️ **Einstellungen** → **Konten verwalten** → **„Trading-Bot“** → **„Privaten Schlüssel anzeigen“** → Passwort eingeben → **kopieren**.
   Füge ihn im Fenster ein und drücke Enter. Du siehst dabei nur Sternchen, das ist Absicht.
6. Es muss **„✔ Wallet verbunden und gespeichert“** erscheinen. Der Assistent prüft selbst, ob Schlüssel und Adresse zusammenpassen.

> ⚠️ **Nur den privaten Schlüssel des Bot-Kontos!** Niemals die **Geheime Wiederherstellungsphrase**
> (12 Wörter) und niemals den Schlüssel deines Hauptkontos. Der Assistent lehnt eine Wortliste
> automatisch ab.

### Schritt 10 (empfohlen): Schnellen Zugang einrichten
Der kostenlose Standard-Zugang zu Solana ist oft überlastet. Besser:
1. Lege auf **https://www.helius.dev** ein kostenloses Konto an.
2. Kopiere im Dashboard die **„Mainnet RPC URL“**.
3. Wähle im Assistenten **`2`** und füge die URL ein. Sie wird getestet und gespeichert.
4. Optional: Hol dir unter **https://portal.jup.ag** einen kostenlosen Jupiter-API-Key und füge ihn im selben Schritt ein.

### Schritt 11: Live schalten
1. Wähle im Assistenten **`3`**: **LIVE-Handel einschalten**.
2. Drücke bei den drei Fragen einfach **Enter**, dann gelten die vorsichtigen Startwerte:
   0,02 SOL pro Kauf, max. 2 Positionen, Tagesverlust-Limit 0,06 SOL.
3. Tippe zur Bestätigung exakt **`ICH_VERSTEHE_DAS_RISIKO`** ein.
4. Mit **`0`** beendest du den Assistenten.

### Schritt 12: Verbindung prüfen und starten
1. Doppelklicke auf **`WALLET_PRUEFEN.bat`**. Die Adresse muss mit „Trading-Bot“ in Phantom übereinstimmen.
2. Doppelklicke auf **`3_BOT_STARTEN.bat`**. Es erscheint **„LIVE – ECHTES GELD“** und ein Countdown von 15 Sekunden.
3. Ab dann handelt der Bot selbstständig. **Jeden Kauf und Verkauf siehst du in Phantom** im Konto „Trading-Bot“.

---

## Trend-Radar (GTA 6 & Co.)

Der Bot liest automatisch Google News, Google Trends, Wikipedia, CoinGecko und DexScreener
und **bevorzugt Meme-Coins, die zu aktuellen Trends passen**. Ab Werk sucht er nach **GTA 6**
(„gta6“, „gta 6“, „gta vi“, „vice city“, „leonida“, „lucia“). Der Release ist für den 19.11.2026 angekündigt.

- **Was findet er gerade?** Doppelklick auf `TRENDS_ANZEIGEN.bat`. Nach ca. 1 Minute siehst du alle
  Trends, passende Coins mit Chart-Link und ob sie die Prüfungen bestehen (✓) oder nicht (✗).
- **Stichwörter ändern oder „nur Trend-Coins kaufen“:** `2_EINRICHTEN.bat` → **`6`**.
- Auch Trend-Coins müssen **alle Sicherheitsprüfungen** bestehen. Es ist normal, dass fast alle
  GTA-Coins durchfallen: Die meisten sind Kopien, haben kaum Umsatz oder gefälschte Zahlen.
- ⚠️ Es gibt **keinen offiziellen GTA-6-Coin**. Event-Coins fallen nach dem Ereignis oft stark.

## Frühphasen-Radar (ganz neue Coins)

Der Bot sieht neue Coins **Sekunden nach dem Start**, beobachtet sie einige Minuten und gibt jedem einen
**Potenzial-Score von 0 bis 100**. Der Score setzt sich aus Trend/Nische, Kaufdynamik, Community und Sicherheit
zusammen. Ab 60 Punkten (einstellbar) und nach bestandener Betrugsprüfung kauft er mit kleinem Betrag (0,02 SOL).

- **Zuschauen:** `FRUEHPHASE_ANSEHEN.bat`. Die Spalte ganz rechts zeigt, warum ein Coin (noch) nicht gekauft würde.
- **Wirkt der Score?** Lass den Bot im Papiermodus **mindestens 2–3 Tage** laufen und öffne dann `AUSWERTUNG.bat`.
  Steht dort „✗ Hohe Scores haben sich NICHT klar besser entwickelt“, solltest du die Frühphase **nicht live** nutzen.
- **Einstellen oder ausschalten:** `2_EINRICHTEN.bat` → **`7`**.
- ⚠️ Das ist der **riskanteste** Teil des Bots. Über 98 % der neuen Coins sterben, oft innerhalb von Minuten.

## Im Alltag

| Situation | Was du tust |
|---|---|
| Bot beenden | Im Bot-Fenster **Strg+C**, dann „Batchvorgang abbrechen?“ mit **N** beantworten. Offene Positionen werden beim nächsten Start weiter verwaltet. |
| Kurz keine neuen Käufe | `KAEUFE_PAUSIEREN.bat` (später `KAEUFE_FORTSETZEN.bat`) |
| Notfall: alles verkaufen | Bot beenden, dann `NOTVERKAUF.bat` und **JA** eintippen |
| Zurück zum Testen ohne Geld | `2_EINRICHTEN.bat` → **`4`** |
| Gewinne sichern | In Phantom SOL von „Trading-Bot“ an dein Hauptkonto senden |
| PC neu gestartet | Einfach wieder `3_BOT_STARTEN.bat` doppelklicken |
| Neue Bot-Version installieren | Neue ZIP in einen **neuen** Ordner entpacken, die Datei `.env` und den Ordner `data` aus dem alten Ordner hineinkopieren, dann `1_INSTALLIEREN.bat` |

## Wenn etwas nicht klappt

| Meldung | Lösung |
|---|---|
| „Node.js ist nicht installiert“ | Schritt 1 wiederholen, danach `1_INSTALLIEREN.bat` erneut starten |
| „Der Bot ist noch nicht installiert“ | Erst `1_INSTALLIEREN.bat` ausführen |
| „Der Bot läuft bereits“ | Es ist schon ein Bot-Fenster offen. Dieses benutzen oder mit Strg+C beenden. |
| „zu wenig SOL“ | Bot-Konto in Phantom aufladen (Schritt 8) |
| Fenster schließt sich sofort | Ordner öffnen, oben in die Adressleiste `cmd` tippen, Enter, dann `npm start` eingeben. So bleibt die Fehlermeldung sichtbar. |
| Anderer Fehler | Die rote Meldung abfotografieren oder kopieren und an Claude schicken. **Niemals den privaten Schlüssel mitschicken!** |

**Ausweichweg ohne `.bat`-Dateien** (auch für Mac/Linux): Öffne im Bot-Ordner ein Terminal und nutze
`npm install`, `npm run einrichten`, `npm start`, `npm run status`, `npm run check-wallet`
bzw. `npm run sell-all -- --ja`.

## Drei goldene Regeln

1. Auf das Bot-Konto kommt nur Geld, dessen Verlust du verkraftest.
2. Niemals Wiederherstellungsphrase, privaten Schlüssel oder die Datei `.env` weitergeben. Phantom und
   echter Support fragen **nie** danach.
3. Erhöhe die Beträge erst, wenn der Bot über Wochen **live** im Plus ist.
