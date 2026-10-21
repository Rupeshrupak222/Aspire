# DEPLOY.md — Running & deploying the Aspire Test Platform

## 1. Local run (development)

```bash
cd aspire-test-platform
cp .env.example .env
# edit .env — at minimum set ADMIN_TOKEN (a random one is generated if you skip this)
npm install
npm start
```

- Student flow: http://localhost:3000/
- Admin panel: http://localhost:3000/admin.html
- Health check: http://localhost:3000/api/health

The SQLite DB is created at `./data/aspire.db` on first run, and 53 sample
questions are seeded automatically (15 aptitude · 30 technical · 8 coding).

## 2. Docker deploy (recommended for the server)

```bash
cp .env.example .env   # fill in ADMIN_TOKEN + Judge0 vars (below)
docker compose up -d --build
```

- `docker-compose.yml` persists `./data` (the SQLite file) across restarts.
- `DB_PATH` inside the container is `/app/data/aspire.db` — do not change it
  unless you also change the volume.
- Suggested production host path: a VM running `aspire.adyapan.com`.

### Suggested subdomain: aspire.adyapan.com

1. DNS: add an **A record** `aspire` → your server's public IP (in the adyapan.com zone).
2. Reverse proxy (nginx) on the server:

```nginx
server {
  server_name aspire.adyapan.com;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
  }
}
```

3. TLS: `certbot --nginx -d aspire.adyapan.com` (Let's Encrypt).

## 3. Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PORT` | no | `3000` | HTTP port |
| `DB_PATH` | no | `./data/aspire.db` | SQLite file (persist with a volume) |
| `ADMIN_TOKEN` | **yes (prod)** | generated+printed | Token for `/api/admin/*` (`x-admin-token` header). Generate: `openssl rand -hex 24` |
| `JUDGE0_ENDPOINT` | for code Qs | empty (disabled) | Judge0 base URL, no trailing slash |
| `JUDGE0_API_KEY` | RapidAPI | empty | RapidAPI key (or bearer token for custom setups) |
| `JUDGE0_RAPIDAPI_HOST` | RapidAPI | empty | e.g. `judge0-ce.p.rapidapi.com` |

## 4. Judge0 setup (code-writing questions)

Without Judge0, the 5 coding questions are **automatically excluded** from tests
(test runs with 35: 10 aptitude + 25 technical) and the admin panel shows a
notice. MCQs work with zero setup.

### Option A — RapidAPI hosted Judge0 (fastest, no server)

1. Sign up at https://rapidapi.com/judge0-official/api/judge0-ce and subscribe
   (free tier available; check current limits).
2. Copy your RapidAPI key.
3. In `.env`:
   ```
   JUDGE0_ENDPOINT=https://judge0-ce.p.rapidapi.com
   JUDGE0_API_KEY=<your rapidapi key>
   JUDGE0_RAPIDAPI_HOST=judge0-ce.p.rapidapi.com
   ```
4. Restart. Admin panel → Judge0 status should read `rapidapi`.

### Option B — Self-hosted Judge0 CE (free, unlimited, needs a server)

1. On a server with Docker:
   ```bash
   # Single-box quick start (see https://github.com/judge0/judge0 for production tuning)
   docker run -d --name judge0 -p 2358:2358 judge0/judge0:latest
   ```
2. In `.env`:
   ```
   JUDGE0_ENDPOINT=http://<judge0-host>:2358
   ```
   (leave `JUDGE0_API_KEY` / `JUDGE0_RAPIDAPI_HOST` empty)
3. Restart. Admin panel → Judge0 status should read `self-hosted`.

**Verify**: add a code question in the admin panel (or use the seeded samples),
take the test, and confirm code answers get graded. The self-test suite
(`npm test`) covers everything except live Judge0 execution.

### Judge0 language ids

Default is `71` (Python 3). Per-question `language_id` can be changed in the
admin panel. Common ids: 71 Python 3, 62 Java, 63 JavaScript (Node), 54 C++ (GCC 9).

## 5. Going live checklist

- [ ] `ADMIN_TOKEN` set to a strong random value; stored in the team's secret manager
- [ ] Judge0 configured (A or B above) and verified with a real code submission
- [ ] Sample questions reviewed: keep, edit, or delete rows with `is_sample=1`
       (admin panel shows the SAMPLE badge; or `DELETE FROM questions WHERE is_sample=1`)
- [ ] Scholarship slabs + test duration reviewed in Admin → Test Config
- [ ] `./data` on a persisted volume (Docker) or backed-up path (bare metal)
- [ ] HTTPS via reverse proxy (nginx + certbot)
- [ ] Test the full flow once in production: register → test → result → certificate
