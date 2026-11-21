# homebridge-klima-vezerlo (v0.1.0)

Szobaszenzor-alapú, naplózó klímavezérlés Homebridge-hez.

- **Szoba-csempe** szobánként: nagyban a valós szobahő (ESP-szenzor), a részleteknél a páratartalom és az akku. 15% alatt alacsony-akku jelzés. Ha a szenzor 40 percig nem küld adatot, a csempe „Nem válaszol” állapotú.
- **„Melegem van” / „Fázok”** gombok (csak a nappalinál). Egy nyomás ±0,5 fok, a következő menetrend-váltásig, naplózva.
- **Szabályozás**: menetrend + tanult eltolás + szobahő-eltérés → a klíma beállított foka és ventilátora.
  - Megfigyelő módban csak kiszámolja és naplózza.
  - Éles módban állítja is.
  - A kézi állítást felismeri, és a következő váltásig nem írja felül.
- **Napló**: `/var/lib/homebridge/klima-naplo/klima-ÉÉÉÉ-HH.csv` (pontosvessző, tizedesvessző – Excelben közvetlenül megnyitható).

## Telepítés (megfigyelő hét)

### 1. Insecure mode
Homebridge felület → Beállítások → **Insecure Mode** be. Utána a Homebridge újraindítása.

Enélkül is elindul a plugin (csempék, gombok, napló), csak a klímák állapotát nem látja.

### 2. A régi webhooks plugin áthelyezése
JSON Config → `HttpWebHooks` blokk: `"webhook_port": "51828"` → **`"51830"`**.

Az új plugin a 51828-as porton fogadja az ESP-k adatait, és továbbítja a régi pluginnak. Így a régi szenzorok és a Home-szabályok változatlanul működnek, firmware-módosítás nem kell.

### 3. A plugin feltöltése
A Mac terminálban, abban a mappában, ahol a `.tgz` van:
```
scp homebridge-klima-vezerlo-0.1.0.tgz pi@homebridge.local:/tmp/
```
A `pi` felhasználó jelszavát kéri.

### 4. Telepítés
Homebridge felület → menü → **Terminal**:
```
cd /var/lib/homebridge && npm install /tmp/homebridge-klima-vezerlo-0.1.0.tgz
```

### 5. Konfiguráció
JSON Config → a `"platforms": [ ... ]` listába:
```json
{
  "platform": "KlimaVezerlo",
  "name": "Klíma vezérlő",
  "mode": "megfigyelo",
  "webhookPort": 51828,
  "forwardUrl": "http://127.0.0.1:51830",
  "rooms": [
    { "id": "nappali", "name": "Nappali szoba", "acName": "Nappali", "buttons": true, "initialBias": 2,
      "schedule": [ { "start": "06:30", "target": 23 }, { "start": "17:00", "target": 24 }, { "start": "23:00", "target": 21, "night": true } ] },
    { "id": "halo", "name": "Háló szoba", "acName": "Hálószoba", "buttons": false, "initialBias": -1.5,
      "schedule": [ { "start": "06:30", "target": 22 }, { "start": "17:00", "target": 22 }, { "start": "23:00", "target": 21, "night": true } ] }
  ]
}
```
Mentés, majd a Homebridge újraindítása.

### 6. Ellenőrzés a logban
- `Szenzor-webhook figyel: 51828 (továbbítás: http://127.0.0.1:51830)`
- `[Nappali szoba] klíma megtalálva: „Nappali” …` – ha 5 percen belül nem jelenik meg, az insecure mode vagy az `acName` a gond.

### 7. A Home appban
Megjelenik a **Nappali szoba**, a **Háló szoba**, a **Melegem van** és a **Fázok**.
- Tedd őket a megfelelő szobába.
- Édesanya iPadjén tedd a kedvencek közé a Nappali szoba csempét és a két gombot.

## Megfigyelő mód megjegyzés
A gombok és a csempe célállítása már most naplóz és eltolja a szoba-célt. A klímát azonban még a meglévő Home-szabályok vezérlik, a plugin csak azt naplózza, mit tenne.

## Éles módra váltás (később)
1. `"mode": "eles"`, majd újraindítás.
2. A 9 Home-automatizálás kikapcsolása.
3. Ha a webhooks plugin már nem kell: a `forwardUrl` törlése, és a plugin kikapcsolása.

## Napló oszlopai
`ido; szoba; esemeny; mod; szobaho; para; akku; kulso; menetrend_cel; eltolas; szoba_cel; tanult; klima_akt_cel; klima_javasolt_cel; klima_sajat_ho; vent_akt; vent_javasolt; klima_be; megjegyzes`

Események: `indulas`, `allapot` (5 percenként), `menetrend`, `gomb`, `csempe`, `klima_valtozas` (megfigyelő mód), `kezi` (éles mód), `parancs`, `szenzor_kiesett`, `szenzor_vissza`, `nem_futes`.

## Teszt
`node test/run-tests.js` (függőség nélkül).
