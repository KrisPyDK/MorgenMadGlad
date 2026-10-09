/**
 * Køres af GitHub Actions (actions/github-script) hver gang der oprettes et
 * issue. Behandler ALLE åbne anmodninger (så intet går tabt hvis flere kommer
 * samtidig), gemmer data.json via GitHub API'et og lukker issues med svar.
 */
import { normalizeData, settle, todayIn } from '../js/schedule.js';
import { RequestError, applyRequest, parseRequest } from './requests.js';

const FOOTER = '\n\n<sub>🤖 Morgenmadsrobotten</sub>';

export default async function run({ github, context, core }) {
  const { owner, repo } = context.repo;
  const branch = context.payload.repository?.default_branch ?? 'main';
  const today = todayIn();

  const issues = await github.paginate(github.rest.issues.listForRepo, {
    owner,
    repo,
    state: 'open',
    sort: 'created',
    direction: 'asc',
    per_page: 100,
  });
  const requests = issues
    .filter((issue) => !issue.pull_request)
    .map((issue) => ({ issue, request: parseRequest(issue, today) }))
    .filter(({ request }) => request);

  if (!requests.length) {
    core.info('Ingen åbne morgenmadsanmodninger.');
    core.setOutput('changed', 'false');
    return;
  }

  const { file, raw } = await readData(github, { owner, repo, branch });
  let data = settle(normalizeData(raw, today), today);

  const results = [];
  for (const { issue, request } of requests) {
    try {
      const result = applyRequest(data, request, {
        today,
        author: issue.user?.login,
        association: issue.author_association,
      });
      data = result.data;
      results.push({ issue, ok: true, message: result.message });
    } catch (error) {
      if (!(error instanceof RequestError)) throw error;
      results.push({ issue, ok: false, message: error.message });
    }
  }

  const content = `${JSON.stringify(data, null, 2)}\n`;
  const changed = content !== file?.content;
  if (changed) {
    const numbers = results.filter((r) => r.ok).map((r) => `#${r.issue.number}`);
    await github.rest.repos.createOrUpdateFileContents({
      owner,
      repo,
      branch,
      path: 'data.json',
      sha: file?.sha,
      message: `🥐 Opdater morgenmadsplanen${numbers.length ? ` (${numbers.join(', ')})` : ''}`,
      content: Buffer.from(content).toString('base64'),
    });
  }

  const pageUrl = pagesUrl(owner, repo);
  for (const { issue, ok, message } of results) {
    const body = ok
      ? `✅ ${message}\n\nSiden er opdateret om et øjeblik: ${pageUrl}${FOOTER}`
      : `❌ ${message}\n\nRet det og opret en ny anmodning fra siden: ${pageUrl}${FOOTER}`;
    await github.rest.issues.createComment({ owner, repo, issue_number: issue.number, body });
    await github.rest.issues.update({
      owner,
      repo,
      issue_number: issue.number,
      state: 'closed',
      state_reason: ok ? 'completed' : 'not_planned',
    });
    core.info(`#${issue.number}: ${ok ? 'OK' : 'afvist'} – ${message}`);
  }

  core.setOutput('changed', String(changed));
}

async function readData(github, { owner, repo, branch }) {
  try {
    const { data } = await github.rest.repos.getContent({ owner, repo, path: 'data.json', ref: branch });
    const content = Buffer.from(data.content, 'base64').toString('utf8');
    return { file: { sha: data.sha, content }, raw: JSON.parse(content) };
  } catch (error) {
    if (error.status === 404) return { file: null, raw: {} };
    throw error;
  }
}

function pagesUrl(owner, repo) {
  const host = `${owner.toLowerCase()}.github.io`;
  return repo.toLowerCase() === host ? `https://${host}/` : `https://${host}/${repo}/`;
}
