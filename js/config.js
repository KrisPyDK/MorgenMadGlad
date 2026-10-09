/**
 * Indstillinger for siden.
 *
 * `apiUrl` er adressen på dit Google Apps Script (slutter på /exec). Når den
 * er sat, gemmes alt direkte i dit Google Sheet, og ingen behøver login.
 * Er den tom, bruges GitHub-issues i stedet. Se README.md for opsætning.
 *
 * `repo` bruges kun hvis siden IKKE ligger på <bruger>.github.io/<repo>
 * (f.eks. lokalt eller på eget domæne). På GitHub Pages findes repoet selv.
 */
export const config = {
  apiUrl: '',
  repo: 'KrisPyDK/MorgenMadGlad',
  weeksAhead: 8,
  historyCount: 12,
};
