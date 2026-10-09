# 🥐 MorgenMadGlad

**Hvem tager morgenbrød med på fredag?**

En lille, bouncy hjemmeside til GitHub Pages, der holder styr på fredagsmorgenmaden:

- **Tilmeld dig** – du kommer bagerst i rotationen.
- **Hver fredag** har den næste på listen morgenbrød med.
- **Aflys en fredag** (fælles møde, helligdag, ferie …) – så rykker den, der havde tur, til fredagen efter, og resten af listen rykker en uge med.
- **Genåbn** en aflyst fredag, hvis planerne ændrer sig.
- Bagerholdet, ugenumre, historik og en masse hoppende wienerbrød. 🥨

## To måder at gemme listen på

| | **Google Sheet** (anbefalet) | **GitHub-issues** (standard indtil du sætter Google op) |
| --- | --- | --- |
| Login for at tilmelde/aflyse | **Ingen** | GitHub-konto |
| Hvornår gemmes det | Med det samme | Efter ca. 1 minut |
| Hvem må hvad | Alle der har linket | Se [rettigheder](#rettigheder-med-github-issues) |
| Opsætning | 5 minutter i Google | Ingen ekstra |

Siden bruger automatisk Google Sheet, så snart `apiUrl` er udfyldt i `js/config.js`.

## Opsætning af siden (én gang)

1. **Default branch:** Sørg for at koden ligger på repoets default branch (f.eks. `main`).
2. **Pages:** Gå til *Settings → Pages* og vælg **Source: GitHub Actions**.
3. Kør workflowet første gang: *Actions → Morgenmad → Run workflow* (eller push en ændring til default branch).

Siden ligger derefter på <https://krispydk.github.io/MorgenMadGlad/>.

> Hvis workflowet fejler med en rettighedsfejl, så tjek *Settings → Actions → General → Workflow permissions* og vælg **Read and write permissions**.

## Gem i Google Sheet – ingen login for kollegerne

Listen gemmes i et Google Sheet, som du ejer. Et lille Apps Script i arket fungerer som "server" for siden. Det er gratis.

1. **Opret et regneark:** Gå til <https://sheets.new> og kald det f.eks. *MorgenMadGlad*.
2. **Åbn Apps Script:** I arket: *Udvidelser → Apps Script*.
3. **Indsæt koden:** Slet alt i `Code.gs`, og indsæt hele indholdet af [`apps-script/Code.gs`](apps-script/Code.gs) fra dette repo. Tryk 💾 *Gem*.
4. **Udgiv som webapp:** *Implementer → Ny implementering* → klik ⚙️ og vælg **Webapp**:
   - *Udfør som:* **Mig**
   - *Hvem har adgang:* **Alle**

   Tryk *Implementer*. Google beder dig give scriptet adgang til arket. Vælg din konto, og hvis du ser *"Google har ikke bekræftet denne app"*, så klik *Avanceret → Gå til … (usikker)*. Det er normalt for dine egne scripts.
5. **Kopiér webapp-URL'en.** Den ender på `/exec`.
6. **Indsæt den i siden:** Ret [`js/config.js`](js/config.js) direkte på GitHub:

   ```js
   apiUrl: 'https://script.google.com/macros/s/…/exec',
   ```

   Commit, og siden udgives automatisk igen.

Færdig! Nu gemmes alt med det samme. I arket kan du følge med:

- **Plan** – de næste 12 fredage.
- **Log** – hvem der tilmeldte, afmeldte, aflyste og genåbnede hvad og hvornår.
- **Data** – selve listen (JSON i celle A1).

### Opdatering af scriptet

Hvis `apps-script/Code.gs` ændres senere, så indsæt den nye kode og vælg *Implementer → Administrer implementeringer → ✏️ → Version: Ny version → Implementer*. URL'en forbliver den samme.

### Fejlfinding

- **"Listen kunne ikke hentes":** Tjek at *Hvem har adgang* er sat til **Alle**, og at URL'en ender på `/exec` (ikke `/dev`).
- **Ændringer kommer ikke med:** Husk at lave en *ny version* af implementeringen efter du har ændret koden.

## GitHub-issues (uden Google)

Er `apiUrl` tom, åbner knapperne et forudfyldt GitHub-issue, som man trykker **Create** på. Workflowet `.github/workflows/morgenmad.yml` opdaterer `data.json`, svarer i issuet, lukker det og udgiver siden igen.

### Rettigheder med GitHub-issues

| Handling           | Hvem                                                        |
| ------------------ | ----------------------------------------------------------- |
| Tilmelde sig       | Alle med en GitHub-konto                                    |
| Afmelde            | Personen selv, eller ejere/collaborators på repoet          |
| Aflyse / genåbne   | Deltagere på listen, eller ejere/collaborators på repoet    |

## Listens format

Både `data.json` (GitHub) og celle A1 i arket *Data* (Google) har samme format:

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
- `history` – tidligere fredage. Fyldes ud automatisk.

Ved hver ændring flyttes `anchor` frem, og tidligere fredage gemmes i `history`, så senere tilmeldinger ikke ændrer på, hvem der havde tur før.

## Udvikling

```bash
npm start       # http://localhost:8080
npm test        # tester planlægningen, GitHub-robotten og Google-scriptet
npm run build   # genererer apps-script/Code.gs efter ændringer i js/ eller apps-script/server.js
```

| Fil                                | Indhold                                                  |
| ---------------------------------- | -------------------------------------------------------- |
| `index.html`, `css/`, `js/app.js`  | Selve siden og animationerne                             |
| `js/schedule.js`                   | Rotationslogikken                                        |
| `js/requests.js`                   | Tilmeld/afmeld/aflys/genåbn – deles af siden og serverne |
| `js/config.js`                     | Google-URL, repo-navn og hvor mange uger der vises       |
| `apps-script/server.js`            | Google Apps Script-serveren                              |
| `apps-script/Code.gs`              | Genereret fil til at kopiere ind i Google                |
| `scripts/`                         | GitHub-robotten og build-scriptet                        |
| `.github/ISSUE_TEMPLATE/`          | Formularerne til GitHub-issues                           |
| `data.json`                        | Listen, når der bruges GitHub-issues                     |
