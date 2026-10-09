# 🥐 MorgenMadGlad

**Hvem tager morgenbrød med på fredag?**

En lille, bouncy hjemmeside til GitHub Pages, der holder styr på fredagsmorgenmaden:

- **Tilmeld dig** – du kommer bagerst i rotationen.
- **Hver fredag** har den næste på listen morgenbrød med.
- **Aflys en fredag** (fælles møde, helligdag, ferie …) – så rykker den, der havde tur, til fredagen efter, og resten af listen rykker en uge med.
- **Genåbn** en aflyst fredag, hvis planerne ændrer sig.
- Bagerholdet, ugenumre, historik og en masse hoppende wienerbrød. 🥨

Hele løsningen kører på GitHub – ingen server, ingen database, ingen hemmelige nøgler.

## Sådan virker det

```
Knap på siden ──► GitHub-issue (forudfyldt) ──► GitHub Action ──► data.json ──► GitHub Pages
```

1. Knapperne på siden åbner et forudfyldt GitHub-issue. Man trykker bare **Create**.
2. Workflowet `.github/workflows/morgenmad.yml` læser alle åbne anmodninger, opdaterer `data.json`, svarer i issuet og lukker det.
3. Siden udgives igen automatisk. Den der sendte anmodningen, ser listen opdatere sig selv efter cirka et minut.

Man skal have en GitHub-konto for at tilmelde sig og aflyse.

### Hvem må hvad?

| Handling           | Hvem                                                        |
| ------------------ | ----------------------------------------------------------- |
| Tilmelde sig       | Alle med en GitHub-konto                                    |
| Afmelde            | Personen selv, eller ejere/collaborators på repoet          |
| Aflyse / genåbne   | Deltagere på listen, eller ejere/collaborators på repoet    |

## Opsætning (én gang)

1. **Default branch:** Sørg for at koden ligger på repoets default branch (f.eks. `main`).
2. **Pages:** Gå til *Settings → Pages* og vælg **Source: GitHub Actions**.
3. **Issues** skal være slået til (det er de som standard).
4. Kør workflowet første gang: *Actions → Morgenmad → Run workflow* (eller push en ændring til default branch).

Siden ligger derefter på `https://<bruger>.github.io/<repo>/` – her: <https://krispydk.github.io/MorgenMadGlad/>.

> Hvis workflowet fejler med en rettighedsfejl, så tjek *Settings → Actions → General → Workflow permissions* og vælg **Read and write permissions**.

## Ret listen i hånden

Alt ligger i `data.json`, som du frit kan redigere direkte på GitHub:

```json
{
  "anchor": "2026-10-16",
  "participants": [{ "name": "Mette" }, { "name": "Bo" }],
  "cancelled": [{ "date": "2026-10-23", "reason": "Fælles møde" }],
  "history": []
}
```

- `anchor` – den fredag rotationen regnes fra. Første person i `participants` har den første ikke-aflyste fredag fra og med denne dato.
- `participants` – rækkefølgen i rotationen. Vil du bytte rundt på folk, så byt rundt her.
- `cancelled` – aflyste fredage.
- `history` – tidligere fredage. Robotten fylder den selv ud.

Robotten flytter selv `anchor` frem og gemmer tidligere fredage i `history`, så senere tilmeldinger ikke ændrer på, hvem der havde tur før.

## Kør lokalt

```bash
npm start   # http://localhost:8080
npm test    # tester planlægningen og robotten
```

## Filer

| Fil                              | Indhold                                           |
| -------------------------------- | ------------------------------------------------- |
| `index.html`, `css/`, `js/app.js` | Selve siden og animationerne                      |
| `js/schedule.js`                 | Rotationslogikken (deles af siden og robotten)    |
| `js/config.js`                   | Repo-navn og hvor mange uger der vises            |
| `scripts/`                       | Robotten der behandler issues                     |
| `.github/ISSUE_TEMPLATE/`        | Formularerne til tilmeld/afmeld/aflys/genåbn      |
| `data.json`                      | Listen                                            |
