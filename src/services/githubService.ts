const GITHUB_API = 'https://api.github.com';

export interface GithubRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  description: string | null;
  archived: boolean;
  default_branch: string;
  clone_url: string;
  /** ISO 8601 timestamp of the last push to this repo. */
  pushed_at: string;
}

export interface GithubOrg {
  id: number;
  login: string;
  description: string | null;
  avatar_url: string;
}

async function ghFetch<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API ${path} → ${res.status} ${res.statusText}: ${body}`);
  }

  return res.json() as Promise<T>;
}

/** Paginate through all pages of a GitHub list endpoint. */
async function ghFetchAll<T>(basePath: string, token: string): Promise<T[]> {
  const results: T[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const sep = basePath.includes('?') ? '&' : '?';
    const data = await ghFetch<T[]>(`${basePath}${sep}per_page=${perPage}&page=${page}`, token);
    results.push(...data);
    if (data.length < perPage) break;
    page++;
  }

  return results;
}

/** List all orgs the authenticated user belongs to. */
export async function listUserOrgs(token: string): Promise<GithubOrg[]> {
  return ghFetchAll<GithubOrg>('/user/orgs', token);
}

/** List all repos in an org (requires read:org + repo scopes). */
export async function listOrgRepos(token: string, org: string): Promise<GithubRepo[]> {
  return ghFetchAll<GithubRepo>(`/orgs/${encodeURIComponent(org)}/repos?type=all`, token);
}

/** List all repos owned by the authenticated user. */
export async function listUserRepos(token: string): Promise<GithubRepo[]> {
  return ghFetchAll<GithubRepo>('/user/repos?affiliation=owner', token);
}

/** Validate a token by fetching the authenticated user. Returns login on success. */
export async function validateToken(token: string): Promise<string> {
  const user = await ghFetch<{ login: string }>('/user', token);
  return user.login;
}
