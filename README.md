# git-unas

A lightweight web admin UI for Ubiquiti UNAS devices. Provides a browser interface served directly on the device to perform **git clone**, **tar archiving**, **file encryption**, **scheduled backups**, and **automated GitHub repository archival** — all from a UniFi-styled dark-theme UI.

Served on `127.0.0.1:7892` and exposed via nginx at `https://<device>/git-unas/`.

---

## Features

| Feature | Description |
|---|---|
| **Git Clone** | Clone any repository to a path on the NAS. Optional branch selection. |
| **Tar Archive** | Create compressed (gzip) or uncompressed archives; extract existing archives. |
| **Encryption** | AES-256-GCM file encryption with PBKDF2 key derivation. `.unas` format. |
| **Scheduled Backup** | Cron-driven tar + rotate: configurable 24h time, day-of-week selection, keep-N rolling retention. |
| **GitHub Archive** | Mirror GitHub repos and orgs via `git clone --mirror`. Hourly / daily / weekly / monthly schedule per entry. 1–180 day retention with per-entry override. Optional AES-256-GCM encryption. |

---

## Install

### One-line (recommended)

SSH to your UNAS device as root and run:

```sh
curl -fsSL https://raw.githubusercontent.com/demiurge28/git-unas/main/gh-pages/install.sh | sh
```

The installer:
1. Downloads and installs the latest `.deb`
2. Injects a proxy block into the UniFi OS nginx config
3. Enables the `git-unas` systemd service
4. Writes a `/data/git-unas/` recovery layer that auto-reinstalls after firmware wipes

The admin UI is then available at `https://<device-ip>/git-unas/`.

### Manual `.deb`

```sh
VER=1.1.0
curl -fsSL -O https://github.com/demiurge28/git-unas/releases/download/v${VER}/git-unas_${VER}_arm64.deb
dpkg -i git-unas_${VER}_arm64.deb
```

### Upgrade

Re-run `dpkg -i` with the new version. The package upgrades in-place; nginx and the service stay live with no downtime window.

### Uninstall

```sh
apt-get remove git-unas          # stops service, strips nginx block
apt-get purge  git-unas          # also removes /etc/git-unas/

# Full purge including firmware-survivability layer:
rm -rf /data/git-unas /etc/cron.d/git-unas-*
```

---

## Architecture

```
Browser
  │  HTTPS
  ▼
UniFi OS nginx  (/git-unas/ → 127.0.0.1:7892)
  │
  ▼
git-unas (Node.js/TypeScript — single ARM64 binary)
  ├── Express HTTP server
  ├── GET  /                    → public/index.html (admin UI)
  ├── GET  /api/status          → version + health
  ├── POST /api/git/clone       → shells out to git(1)
  ├── POST /api/tar/create      → shells out to tar(1)
  ├── POST /api/tar/extract     → shells out to tar(1)
  ├── POST /api/encrypt/encrypt → Node.js crypto (AES-256-GCM)
  ├── POST /api/encrypt/decrypt → Node.js crypto (AES-256-GCM)
  ├── GET  /api/schedule              → current config + next run + backup list
  ├── POST /api/schedule              → update config + restart cron
  ├── POST /api/schedule/run          → immediate backup trigger
  ├── GET  /api/archive/config        → GitHub archive settings (token masked)
  ├── POST /api/archive/config        → save settings + restart archive scheduler
  ├── GET  /api/archive/orgs          → list GitHub orgs via API
  ├── GET  /api/archive/repos?org=    → list repos in org or user repos
  ├── GET  /api/archive/status        → entries with next run + last status
  ├── POST /api/archive/entries       → add repo or org entry
  ├── PATCH/DELETE /api/archive/entries/:id
  ├── POST /api/archive/run           → archive all enabled entries now
  └── POST /api/archive/run/:id       → archive one entry now

Persistence
  /etc/git-unas/schedule.json         ← scheduled backup config
  /etc/git-unas/archive-config.json   ← GitHub archive config (token encrypted at rest)
  /etc/default/git-unas               ← PORT, config paths (conffile)

Firmware survivability
  /data/git-unas/install.sh     ← cached installer
  /data/git-unas/boot-restore.sh← @reboot cron — reinstalls after firmware wipe
  /data/git-unas/backup.sh      ← daily config snapshot
  /etc/cron.d/git-unas-*        ← cron entries (survive firmware wipes)
```

### Encryption file format

```
Offset  Size   Field
0       4      Magic: "UNAS"
4       32     Salt (random, PBKDF2 input)
36      12     IV (random, AES-GCM nonce)
48      16     GCM auth tag
64      N      Ciphertext

Key derivation: PBKDF2-SHA256, 100 000 iterations, 32-byte output
Cipher: AES-256-GCM (authenticated — wrong passphrase is detected)
```

---

## Configuration

### Environment overrides

Edit `/etc/default/git-unas.local` (never overwritten by upgrades):

```sh
PORT=7892
SCHEDULE_CONFIG_PATH=/etc/git-unas/schedule.json
ARCHIVE_CONFIG_PATH=/etc/git-unas/archive-config.json
```

### Scheduled backup (`/etc/git-unas/schedule.json`)

```json
{
  "enabled": true,
  "hour": 6,
  "minute": 0,
  "days": [],
  "source": "/mnt/data",
  "backupDir": "/mnt/backups",
  "keepCount": 7
}
```

`days` — array of `"mon"–"sun"`; empty array means every day.

### GitHub archive (`/etc/git-unas/archive-config.json`)

```json
{
  "githubToken": "ghp_...",
  "baseDir": "/mnt/nas/github-archives",
  "defaultFrequency": "daily",
  "retentionDays": 30,
  "encrypt": false,
  "passphrase": "",
  "entries": [
    {
      "id": "uuid",
      "type": "repo",
      "owner": "myorg",
      "repo": "backend",
      "frequency": null,
      "retentionDays": null,
      "enabled": true
    },
    {
      "id": "uuid",
      "type": "org",
      "owner": "myorg",
      "includeRepos": ["*"],
      "excludeRepos": ["archived-repo"],
      "frequency": "weekly",
      "retentionDays": 90,
      "enabled": true
    }
  ]
}
```

`frequency` — `"hourly"` / `"daily"` / `"weekly"` / `"monthly"` or `null` to inherit the global default.
`retentionDays` — `1`–`180` or `null` to inherit the global default (30).

All settings are managed via the admin UI. Changes take effect immediately without a service restart.

---

## Development

### Prerequisites

- Node.js 18+
- `task` (Taskfile runner)

### Setup

```sh
git clone https://github.com/demiurge28/git-unas
cd git-unas
npm install
```

### Common tasks

```sh
task dev             # start dev server with hot-reload (ts-node)
task check           # fmt + lint + build + test:coverage (pre-commit gate)
task fmt             # prettier
task lint            # eslint
task build           # tsc → dist/
task test            # jest
task test:coverage   # jest --coverage (≥85% threshold)
task clean           # rm -rf dist/
```

### Building the ARM64 release binary

Requires the TypeScript build to have run first:

```sh
npm run build
npm run build:binary   # → dist/git-unas-arm64 (single self-contained binary)
```

### Building the `.deb`

Requires `dpkg-deb` (install via `brew install dpkg` on macOS):

```sh
npm run build
npm run build:binary
scripts/build-deb.sh --arch arm64 --version 1.1.0
# → dist/git-unas_1.1.0_arm64.deb
```

### Cutting a release

Push a `v*` tag. The GitHub Actions workflow (`release-deb.yml`) builds the ARM64 binary, packages the `.deb`, and publishes it as a release asset automatically.

```sh
git tag v1.1.0
git push origin v1.1.0
```

---

## Tests

147 tests across 10 suites:

| Suite | Tests | Coverage |
|---|---|---|
| `archiveService` | 34 | config, pruning, filename parsing, retention, scheduler |
| `archiveRoute` | 20 | all endpoints, validation, token preservation, entry CRUD |
| `scheduleService` | 22 | config, backup rotation, cron, next-run date |
| `scheduleRoute` | 12 | GET/POST /api/schedule, validation, immediate run |
| `encryptService` | 11 | round-trip text/binary/empty, magic bytes, wrong passphrase |
| `encryptRoute` | 12 | all fields, wrong passphrase, non-Error rejections |
| `tarRoute` | 10 | create/extract, compress flag, error propagation |
| `tarService` | 12 | -czf/-cf flags, -C split, exit codes, spawn errors |
| `gitRoute` | 7 | validation, success, branch forwarding, error handling |
| `gitService` | 7 | spawn args, --branch, exit codes, spawn errors |

```sh
npm test
```

---

## Compatibility

Tested on Ubiquiti Dream Machine / Dream Router running UniFi OS 4.x (Debian arm64). The binary is a self-contained Node.js 22 executable — no Node.js installation required on the device.

## Changelog

### v1.1.0
- **GitHub Archive** — mirror repos and orgs via `git clone --mirror`; hourly/daily/weekly/monthly schedule per entry; 1–180 day retention with per-entry override; optional AES-256-GCM encryption; browser UI with org picker and repo checklist
- **Scheduled Backup** — cron-driven tar backup with 24h time picker, day-of-week selection, and keep-N rotation
- **ARM64 `.deb` packaging** — nginx proxy injection, systemd service, firmware-survivability boot-restore layer
- 147 tests across 10 suites

### v1.0.0
- Initial release: git clone, tar archive, AES-256-GCM file encryption, UniFi dark-theme admin UI
