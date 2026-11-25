const token = process.env.GITHUB_TOKEN;
if (!token) { console.error('Preencha GITHUB_TOKEN no .env.'); process.exit(1); }
const owner = process.env.GITHUB_OWNER || 'luisfelipe998';
const repo = process.env.GITHUB_REPO || 'Apartamento';
const issue = process.env.GITHUB_ISSUE_NUMBER || '1';
try {
  const headers = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const issuePath = '/repos/' + owner + '/' + repo + '/issues/' + issue;
  for (const path of ['/user', issuePath, issuePath + '/comments?per_page=1']) {
    const response = await fetch('https://api.github.com' + path, { headers, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('GitHub respondeu HTTP ' + response.status + '. Confira o token e as permissões.');
    const data = await response.json();
    console.log(Array.isArray(data) ? 'Leitura dos comentários da issue confirmada.'
      : data.login ? 'Conta autenticada: ' + data.login : 'Issue acessível: #' + data.number + ' — ' + data.title);
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
