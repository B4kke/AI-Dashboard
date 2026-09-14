import { parseGitHubRepository } from './github.mjs';

export async function githubCommitTreeSha({ github, repository, sha }) {
  if (!github?.request) throw new Error('GitHub client cannot read commit evidence');
  if (!sha) throw new Error('Merge commit SHA is missing');
  const { owner, repo } = parseGitHubRepository(repository);
  const commit = await github.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits/${encodeURIComponent(sha)}`);
  const tree = commit?.tree?.sha || null;
  if (!tree || !/^[0-9a-f]{40,64}$/i.test(tree)) throw new Error('GitHub merge commit did not expose a valid tree SHA');
  return tree;
}
