# Meme-Coin-Trader (Solana / Phantom)

Ein automatischer Trading-Bot für Solana-Meme-Coins. Er sucht selbstständig neue Token,
prüft sie auf Betrug (Rug-Pull, Honeypot, Wal-Konzentration), kauft über **Jupiter**
(den größten Solana-DEX-Aggregator) und verkauft automatisch per Stop-Loss, Take-Profit,
Trailing-Stop oder Zeitlimit.

> ## ⚠️ Bitte zuerst lesen
>
> - **Meme-Coins sind extrem riskant.** Auswertungen der Plattform Pump.fun zeigen, dass die
>   Mehrheit der Trader dort Verluste macht oder nur sehr kleine Gewinne realisiert, je nach
>   Zeitraum und Methode. Ein Bot ändert daran nichts Grundsätzliches. **Kein Bot kann
>   Gewinne garantieren.** Setze nur Geld ein, dessen Totalverlust du verkraften kannst.
> - Der Bot startet **immer im Papiermodus** (simuliert, mit echten Kursen). Lass ihn mindestens
>   einige Tage so laufen und sieh dir die Ergebnisse an, bevor du echtes Geld einsetzt.
> - **Verwende niemals deine Seed-Phrase und niemals dein Hauptkonto.** Lege in Phantom ein
>   separates Bot-Konto mit wenig Guthaben an (Anleitung unten).
> - Auf GitHub gibt es viele **gefälschte „Solana-Trading-Bots“, die Wallets leerräumen**. Ein
>   bekanntes Beispiel war 2025 das Repo `solana-pumpfun-bot`, das private Schlüssel an einen
>   fremden Server schickte (SlowMist-Analyse). Deshalb nutzt dieses Projekt **keinen fremden
>   Bot-Code**, sondern nur drei offizielle, weit verbreitete npm-Pakete mit fest gepinnten
>   Versionen (`@solana/web3.js`, `bs58`, `dotenv`). Dein Schlüssel verlässt nie deinen Rechner:
>   Transaktionen werden lokal signiert, nur die signierte Transaktion geht an Jupiter.

---

## Inhalt

1. [Wie der Bot mit Phantom zusammenarbeitet](#1-wie-der-bot-mit-phantom-zusammenarbeitet)
2. [Installation](#2-installation)
3. [Papierhandel (Test ohne Geld)](#3-papierhandel-test-ohne-geld)
4. [Live-Handel aktivieren](#4-live-handel-aktivieren)
5. [Befehle](#5-befehle)
6. [So entscheidet der Bot](#6-so-entscheidet-der-bot)
7. [Einstellungen](#7-einstellungen)
8. [Recherche: Vorlagen & Erfahrungen](#8-recherche-vorlagen--erfahrungen)
9. [Grenzen & bekannte Risiken](#9-grenzen--bekannte-risiken)
10. [Steuern (Deutschland)](#10-steuern-deutschland)

---

## 1. Wie der Bot mit Phantom zusammenarbeitet

Phantom ist eine Browser- und App-Wallet: **Jede Transaktion muss dort per Klick bestätigt
werden.** Ein Bot, der Tag und Nacht selbstständig handelt, kann deshalb nicht direkt über die
Phantom-Erweiterung signieren. Alle seriösen Bots arbeiten so:

1. In Phantom ein **neues, separates Konto** anlegen: Konto-Symbol oben links → **„Konto hinzufügen“** →
   „Neues Konto erstellen“. Nenne es z. B. „Trading-Bot“.
2. Von deinem Hauptkonto nur so viel SOL auf das Bot-Konto senden, wie du **maximal verlieren
   willst** (z. B. 0,3 – 0,5 SOL zum Start).
3. Für **genau dieses Bot-Konto** den privaten Schlüssel exportieren:
   **Einstellungen → Konten verwalten → Bot-Konto → „Privaten Schlüssel anzeigen“**.
4. Den Schlüssel in die Datei `.env` bei `PRIVATE_KEY=` eintragen und die öffentliche Adresse des
   Bot-Kontos bei `EXPECTED_WALLET_ADDRESS=`.

Das Bot-Konto bleibt in Phantom sichtbar. **Du siehst dort jeden Kauf und Verkauf live** und
kannst jederzeit selbst eingreifen. Wenn du in Phantom manuell verkaufst, erkennt der Bot das
und schließt die Position.

Gesperrt ist Folgendes, und der Bot verweigert dann den Start:
- eine Seed-Phrase (12/24 Wörter) statt eines privaten Schlüssels,
- ein Schlüssel, der nicht zu `EXPECTED_WALLET_ADDRESS` passt,
- Live-Handel ohne die ausdrückliche Bestätigung `LIVE_TRADING_CONFIRM`.

## 2. Installation

Voraussetzung: **Node.js 20 oder neuer** ([nodejs.org](https://nodejs.org), „LTS“ wählen).

```bash
git clone https://github.com/kalle3012/meme-coin-trader-.git
cd meme-coin-trader-
npm install
cp .env.example .env        # Windows: copy .env.example .env
```

Danach `.env` mit einem Texteditor öffnen. Für den Papiermodus musst du nichts ändern.

Optional, aber empfohlen:
- **Kostenloser Jupiter-API-Key** von [portal.jup.ag](https://portal.jup.ag) → `JUPITER_API_KEY`
  (verdoppelt die erlaubten Anfragen; ohne Key sind es 0,5 pro Sekunde).
- **Eigener RPC-Zugang** (z. B. kostenlos bei Helius oder QuickNode) → `RPC_URL`. Der öffentliche
  Solana-Endpunkt ist stark limitiert und für Live-Betrieb nicht zuverlässig.

## 3. Papierhandel (Test ohne Geld)

```bash
npm start
```

Der Bot nutzt echte Marktdaten und echte Jupiter-Kurse, aber ein simuliertes Guthaben
(`PAPER_START_SOL`, Standard 1 SOL). Alles wird protokolliert:

- `data/bot.log`: alle Entscheidungen, mit Begründung für jede Ablehnung
- `data/trades.csv`: Trade-Journal (lässt sich mit Excel öffnen, Trennzeichen `;`)
- `data/state.paper.json`: offene Positionen und Statistik

Mit `npm run status` siehst du jederzeit Guthaben, offene Positionen und das Ergebnis.

**Hinweis:** Die Filter sind absichtlich streng. Es ist normal, dass der Bot stundenlang nichts kauft:
Die meisten neuen Meme-Coins fallen bei den Sicherheitsprüfungen durch. Mit `DEBUG=true` siehst du
für jeden Token, warum er abgelehnt wurde.

Papierergebnisse sind **etwas zu optimistisch**: Im echten Handel kommen Slippage,
fehlgeschlagene Transaktionen und schnellere Kursbewegungen dazu.

## 4. Live-Handel aktivieren

Erst wenn du den Papiermodus ausgewertet hast:

1. Bot-Konto in Phantom anlegen und aufladen (siehe Abschnitt 1).
2. In `.env` eintragen:
   ```ini
   PRIVATE_KEY=<privater Schlüssel des Bot-Kontos>
   EXPECTED_WALLET_ADDRESS=<öffentliche Adresse des Bot-Kontos>
   ```
3. Verbindung prüfen. Dieser Befehl handelt nicht:
   ```bash
   npm run check-wallet
   ```
   Die angezeigte Adresse muss mit dem Bot-Konto in Phantom übereinstimmen.
4. Live schalten:
   ```ini
   DRY_RUN=false
   LIVE_TRADING_CONFIRM=ICH_VERSTEHE_DAS_RISIKO
   ```
5. `npm start`. Der Bot zeigt 15 Sekunden lang eine Warnung an. In dieser Zeit kannst du mit Strg+C
   abbrechen.

Empfehlung für den Anfang: `BUY_AMOUNT_SOL=0.02` bis `0.05`, `MAX_OPEN_POSITIONS=2`.

Damit der Bot dauerhaft läuft, muss der Rechner an bleiben. Alternativ läuft er auf einem
kleinen VPS (Linux-Server), z. B. mit `pm2` oder `screen`.

## 5. Befehle

| Befehl | Wirkung |
|---|---|
| `npm start` | Bot starten |
| Strg+C | Bot sauber beenden. Offene Positionen bleiben offen und werden beim nächsten Start weiter verwaltet. |
| `npm run status` | Guthaben, offene Positionen und Statistik anzeigen |
| `npm run check-wallet` | Wallet-Verbindung prüfen (ohne zu handeln) |
| `npm run sell-all` | Notverkauf aller Positionen. Im Live-Modus: `npm run sell-all -- --ja` (Bot vorher beenden) |
| Datei `STOP` im Projektordner anlegen | Bot kauft nichts mehr, verwaltet aber bestehende Positionen weiter. Datei löschen = weiter kaufen. |
| `npm test` | 51 automatische Tests der Entscheidungslogik |

## 6. So entscheidet der Bot

Jede Minute läuft ein Scan in drei Prüfstufen. Ein Token wird nur gekauft, wenn er **alle** besteht:

**Stufe 0: Token finden.** Quellen sind DexScreener (neue Token-Profile und Boosts) und die
Jupiter Tokens API (Trending und hoher „Organic Score“, also echte Nutzer statt Bot-Volumen).

**Stufe 1: Marktdaten (DexScreener).**
- Liquidität ≥ 25.000 $, Market Cap zwischen 75.000 $ und 10 Mio. $
- Mindestens 60 Minuten und höchstens 72 Stunden alt. Die meisten Rug-Pulls passieren in den
  ersten Minuten oder Stunden, besonders beim Wechsel von der Bonding-Curve auf eine DEX.
- Volumen in 1 h ≥ 15.000 $ und mindestens 150 Transaktionen
- Mehr Käufe als Verkäufe in der letzten Stunde
- Kurs in 1 h gestiegen, aber nicht um mehr als 100 % (kein Kauf am Hoch nach einem Pump)
- Kurs fällt nicht gerade (5-Minuten-Änderung ≥ −3 %)
- Website oder Social-Media-Links vorhanden

**Stufe 2: Sicherheit (RugCheck).**
- **Mint-Authority entzogen.** Sonst kann der Entwickler unbegrenzt neue Token drucken.
- **Freeze-Authority entzogen.** Sonst kann er Verkäufe blockieren, der Token ist dann ein Honeypot.
- Keine Transfer-Steuer (Token-2022), nicht als „rugged“ markiert, keine Risiken der Stufe „danger“
- RugCheck-Score ≤ 30 (Skala 0–100, niedriger ist besser)
- Top-10-Holder ≤ 30 %, größter Holder ≤ 8 %. Liquiditätspools werden herausgerechnet.
- Verbundene Insider-Wallets halten ≤ 15 %, mindestens 300 Holder

**Stufe 3: Handelbarkeit (Jupiter).** Der Bot fragt bei Jupiter echte Kurse für einen Kauf und den
sofortigen Wiederverkauf ab. Gehen dabei mehr als 8 % verloren (Honeypot, versteckte Steuer, zu
wenig Liquidität), wird der Token abgelehnt. Der Preiseinfluss des Kaufs muss ≤ 3 % sein.

**Ausstieg (alle 15 Sekunden geprüft, auf Basis echter Verkaufskurse von Jupiter):**
- **Stop-Loss** bei −20 %
- **Take-Profit** bei +50 %: Die Hälfte wird verkauft, der Rest läuft weiter.
- **Trailing-Stop:** Ab +25 % (oder nach dem Take-Profit) wird verkauft, wenn der Kurs 20 % unter das
  bisherige Hoch fällt.
- **Zeitlimit:** Nach spätestens 3 Stunden wird verkauft.
- Schlägt ein Verkauf fehl (z. B. im Crash), wird er beim nächsten Durchlauf mit höherer erlaubter
  Slippage wiederholt, maximal 20 %.

**Risiko-Limits:**
- Fester Betrag pro Kauf, höchstens 3 Positionen gleichzeitig, höchstens ein Kauf pro Scan
- Tagesverlust-Limit: Ab 0,15 SOL realisiertem Verlust kauft der Bot bis zum nächsten Tag nichts mehr.
- Höchstens 15 Käufe pro Tag
- Eine SOL-Reserve (0,05) bleibt immer für Gebühren und Verkäufe übrig.
- Derselbe Token wird 24 Stunden lang nicht erneut gekauft.

**Ausführung (Live):** Jupiter Swap API V2. Der Bot holt die Order (`/order`), signiert sie lokal
und reicht sie über `/execute` ein. Danach prüft er **on-chain**, wie viele Token bzw. SOL
tatsächlich angekommen sind, statt nur der API-Antwort zu vertrauen. Der Zustand wird nach jeder
Änderung gespeichert, damit nach einem Absturz keine Position verloren geht.

## 7. Einstellungen

Alle Parameter stehen kommentiert in [`.env.example`](.env.example). Jeder Wert wird beim Start
geprüft. Unsinnige Werte (z. B. Stop-Loss 0 %, Text statt Zahl) führen zu einer klaren
Fehlermeldung statt zu falschen Trades.

## 8. Recherche: Vorlagen & Erfahrungen

Vor der Entwicklung wurden Open-Source-Projekte, offizielle API-Dokumentationen und Berichte aus
Krypto-Medien und von Sicherheitsfirmen ausgewertet. Die Kernergebnisse:

**GitHub-Vorlagen.** Es gibt viele Solana-Meme-Bots. Als Ideengeber wurden Beschreibung und
Funktionsumfang u. a. dieser Projekte ausgewertet: `SolarCrown/ScreenerBot` (Rust, Screener mit Rug-Filter, DCA, Trailing-Stop),
`Frenzy911/solana-memecoin-bot` (Python, Papierhandel mit echten Jupiter-Kursen und RugCheck),
`fariz4446/MemeBot` (standardmäßig simuliert) und `oboshto/tradie` (TypeScript, Jupiter).
Daraus übernommen wurden nur bewährte **Konzepte**, kein Code: Papiermodus als Standard,
DexScreener plus RugCheck als Filter, echte Jupiter-Quotes für die Simulation, Trailing-Stop.

**Warnung vor gefälschten Bots.** Mehrere Sicherheitsberichte (SlowMist, Cointelegraph, 2025)
beschreiben GitHub-Repos, die als Pump.fun-Bots getarnt waren und über manipulierte Abhängigkeiten
private Schlüssel stahlen. Ihre Sterne und Forks waren über Fake-Konten aufgeblasen. Daraus folgt:
Viele Sterne beweisen keine Sicherheit, jede Abhängigkeit gehört geprüft, und der Bot nutzt nur
ein separates Konto mit wenig Geld.

**Erfahrungen und Statistiken.**
- Dune-Auswertungen von 2025 zeigten, dass über die Hälfte der Pump.fun-Wallets Verluste hatte und
  nur ein winziger Bruchteil große Gewinne realisierte. Neuere CoinGecko-Daten von 2026 zeigen
  bessere Monate. Die Zahlen hängen stark von der Methode ab, unrealisierte Verluste fehlen
  meist ganz.
- Sandwich-Angriffe durch MEV-Bots sind auf Solana weiterhin verbreitet. **Hohe Slippage lädt
  dazu ein.** Viele Telegram-Bots empfehlen 20–30 % Slippage, dieser Bot nutzt standardmäßig 3 %.
- Honeypots über die Freeze-Authority (Verkauf blockiert) sind ein bekanntes Muster. Der Bot prüft
  deshalb die Freeze-Authority und zusätzlich den simulierten Wiederverkauf.
- Rug-Pulls häufen sich in den ersten Minuten und beim Wechsel von der Bonding-Curve zur DEX. Daher
  gelten ein Mindestalter und ein Mindestbetrag an Liquidität.

**Geprüfte APIs (Stand Nov. 2026, live getestet):**
- Jupiter Swap API V2 (`api.jup.ag/swap/v2/order` und `/execute`). `lite-api.jup.ag` wird abgeschaltet.
- Jupiter Tokens API V2 (Trending / Organic Score)
- DexScreener (`/token-boosts`, `/token-profiles`, `/tokens/v1/solana/...`)
- RugCheck (`api.rugcheck.xyz/v1/tokens/{mint}/report`)
- `@solana/web3.js` v3 (aktuelle Version mit asynchroner Signatur)

## 9. Grenzen & bekannte Risiken

- **Keine Gewinngarantie.** Auch Token, die alle Prüfungen bestehen, können abstürzen oder später
  manipuliert werden. RugCheck & Co. erkennen nicht jeden Betrug.
- **Schnelle Crashs:** Meme-Coins fallen manchmal in Sekunden um 50–90 %. Ein Stop-Loss bei −20 %
  wird dann deutlich tiefer ausgeführt.
- **Nicht verkaufbare Token:** Lässt sich ein Token 10 Minuten lang gar nicht verkaufen (keine
  Route, Liquidität abgezogen), schreibt der Bot die Position als Totalverlust ab. Die Token
  bleiben in der Wallet.
- **Abhängigkeit von externen Diensten:** Fallen Jupiter, DexScreener, RugCheck oder der RPC aus,
  pausiert der Bot den jeweiligen Schritt und versucht es erneut.
- **Der Live-Modus wurde nur bis zur Transaktionserstellung getestet.** Der komplette Zyklus lief
  im Papiermodus mit echten Kursen, die Sicherheitssperren mit einer leeren Test-Wallet, und echte
  Jupiter-Transaktionen wurden dekodiert und geprüft. Ein echter Swap mit Geld wurde bei der
  Entwicklung nicht ausgeführt. Starte deshalb mit sehr kleinen Beträgen.

## 10. Steuern (Deutschland)

Gewinne aus Kryptowährungen, die du **weniger als ein Jahr** hältst, sind in Deutschland als private
Veräußerungsgeschäfte steuerpflichtig. Es gilt eine Freigrenze von 1.000 € pro Jahr (seit 2024).
Das Trade-Journal `data/trades.csv` enthält Zeitpunkt, Beträge und Transaktions-Signatur jedes
Trades als Grundlage. Für die Bewertung in Euro und die Details wende dich bitte an einen
Steuerberater oder nutze ein Krypto-Steuertool.

---

**Haftungsausschluss:** Dieses Projekt ist Software zu Lern- und Forschungszwecken und keine
Anlageberatung. Die Nutzung erfolgt auf eigenes Risiko.
