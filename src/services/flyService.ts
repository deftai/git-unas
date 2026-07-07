/**
 * Thin HTTP client for the Fly.io Machines REST API.
 * Base URL: https://api.machines.dev/v1
 * Auth:     Authorization: Bearer <token>
 *
 * No flyctl CLI required. Uses Node 22 built-in fetch.
 */

const FLY_API_BASE = 'https://api.machines.dev/v1';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FlyApp {
  id: string;
  name: string;
  status: string;
  machine_count?: number;
  volume_count?: number;
  network?: string;
}

export interface FlyMachineConfig {
  image?: string;
  env?: Record<string, string>;
  services?: unknown[];
  checks?: unknown;
  [key: string]: unknown;
}

export interface FlyMachine {
  id: string;
  name: string;
  state: string;
  region: string;
  instance_id?: string;
  private_ip?: string;
  config?: FlyMachineConfig;
  image_ref?: { registry: string; repository: string; tag: string; digest: string };
  created_at?: string;
  updated_at?: string;
}

export interface FlySecret {
  name: string;
  digest?: string;
  created_at?: string;
  label?: string;
  version?: number;
}

export interface FlyVolume {
  id: string;
  name: string;
  state: string;
  size_gb: number;
  region: string;
  encrypted?: boolean;
  created_at?: string;
  attached_machine_id?: string;
  fstype?: string;
}

export interface FlyAppSnapshot {
  name: string;
  status: string;
  machineCount: number;
  volumeCount: number;
  machines: FlyMachine[];
  secrets: FlySecret[];
  volumes: FlyVolume[];
}

export interface FlyArchiveSnapshot {
  timestamp: string;
  orgSlug: string;
  appCount: number;
  apps: FlyAppSnapshot[];
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function flyGet<T>(token: string, path: string): Promise<T> {
  const url = `${FLY_API_BASE}${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Fly API ${path} → HTTP ${String(res.status)}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Public API functions
// ---------------------------------------------------------------------------

/** List all apps in an org. Requires org_slug. */
export async function getFlyApps(token: string, orgSlug: string): Promise<FlyApp[]> {
  const data = await flyGet<{ apps?: FlyApp[]; total_apps?: number }>(
    token,
    `/apps?org_slug=${encodeURIComponent(orgSlug)}`,
  );
  return data.apps ?? [];
}

/** Get full machine configs for an app. */
export async function getFlyMachines(token: string, appName: string): Promise<FlyMachine[]> {
  const data = await flyGet<FlyMachine[]>(token, `/apps/${encodeURIComponent(appName)}/machines`);
  return Array.isArray(data) ? data : [];
}

/** Get secret names (and version metadata) for an app. Values are never returned by the API. */
export async function getFlySecrets(token: string, appName: string): Promise<FlySecret[]> {
  try {
    const data = await flyGet<FlySecret[]>(token, `/apps/${encodeURIComponent(appName)}/secrets`);
    return Array.isArray(data) ? data : [];
  } catch {
    // Some app types may not support the secrets endpoint — treat as empty
    return [];
  }
}

/** Get volume list for an app. */
export async function getFlyVolumes(token: string, appName: string): Promise<FlyVolume[]> {
  try {
    const data = await flyGet<FlyVolume[]>(token, `/apps/${encodeURIComponent(appName)}/volumes`);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/**
 * Verify a token by fetching the app list.
 * Returns org slug and app count on success; throws on auth failure.
 */
export async function verifyFlyToken(
  token: string,
  orgSlug: string,
): Promise<{ orgSlug: string; appCount: number }> {
  const apps = await getFlyApps(token, orgSlug);
  return { orgSlug, appCount: apps.length };
}
