# Nipuna CRM — Test Deployment (AWS EC2)

How the test server is built, how to redeploy to it, and how to run it day to day. It is a single EC2 instance: nginx serves the built frontend and proxies `/api` to Flask (gunicorn), and Postgres runs on the same machine. Local setup is in [DEVELOPMENT.md](DEVELOPMENT.md).

> ## ⚠️ Always check the AWS account first
>
> The test server lives in **Manoj's personal AWS account `307857432997`**, never in the ConveGenius company account (`801257650467`).
>
> **Before every AWS command** (launch, stop, start, security group change, anything), confirm the account:
>
> ```bash
> aws sts get-caller-identity --profile nipuna --query Account --output text
> # must print: 307857432997
> ```
>
> If it prints anything else, **stop**. Don't run the command.
>
> - Always pass `--profile nipuna` (the personal account; keys come from `backend/.env`).
> - The company key is kept under `--profile convegenius` only. The `[default]` profile is intentionally empty, so a command without `--profile` fails instead of hitting the company account.
> - The personal keys go into the profile without being printed:
>   ```bash
>   aws configure --profile nipuna   # region ap-south-1, output json
>   ```

---

## 1. The server

| Item | Value |
|---|---|
| AWS account | `307857432997` (personal), profile `nipuna` |
| Region / zone | `ap-south-1` (Mumbai) / `ap-south-1b` |
| Instance | `i-0f56f0778b34411e7`, Name `nipuna-crm-test`, **t3.micro** (2 vCPU, 1 GB RAM + 2 GB swap) |
| OS | Ubuntu 24.04 LTS, timezone Asia/Kolkata |
| Disk | 20 GB gp3 |
| Public address | Auto-assigned public IPv4, **no Elastic IP**, so it **changes on every stop/start** (see section 5) |
| URL | **https://13-201-78-226.sslip.io** (sslip.io maps the dashed IP to the address; HTTP redirects to HTTPS) |
| TLS certificate | Let's Encrypt via certbot (nginx plugin), registered without an email, auto-renewed by `certbot.timer`. It is tied to the hostname, so it has to be re-issued when the IP changes |
| Security group | `sg-02132530c3cbda43c` (`nipuna-crm-test`): 22 from the developer's IP only, 80 and 443 from anywhere. 5432 is not open |
| SSH key | `~/.ssh/nipuna-crm-test` (AWS key pair `nipuna-crm-test`) |
| Approx. cost | ~$0.019/hour, ~$13.70/month running all the time (instance + disk + public IPv4), before GST |

```bash
IP=$(aws ec2 describe-instances --profile nipuna --instance-ids i-0f56f0778b34411e7 \
     --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
ssh -i ~/.ssh/nipuna-crm-test ubuntu@$IP
open https://${IP//./-}.sslip.io
```

### Layout on the server

| Path / unit | What |
|---|---|
| `/srv/nipuna/backend` | Flask app (no tests, no local `.env`) |
| `/srv/nipuna/backend/.env` | Server-only config: `APP_ENV=production`, `DATABASE_URL`, `SECRET_KEY`, `UPLOAD_DIR`. Generated on the server, never copied from a laptop, mode 600 |
| `/srv/nipuna/backend/uploads` | Uploaded documents, payment proofs, CVs |
| `/srv/nipuna/db` | SQL migrations |
| `/srv/nipuna/frontend` | Built frontend (`frontend/dist` contents) |
| `/srv/nipuna/venv` | Python 3.12 venv (`requirements.txt` + gunicorn) |
| `nipuna.service` (systemd) | gunicorn, 2 workers, `127.0.0.1:5050`, restarts automatically |
| `/etc/nginx/sites-available/nipuna` | Port 443 (certbot-managed TLS, port 80 redirects): static frontend with SPA fallback to `index.html`, `/api/` → `127.0.0.1:5050`, 10 MB upload limit |
| `ubuntu` crontab | `flask --app app jobs run` every minute → `/srv/nipuna/jobs.log` |

### Database

- **PostgreSQL 18** (PGDG repo, the same major version as local development), listening on `127.0.0.1:5432` only.
- **One database: `nipunacrm`** (production), owned by role `nipuna`. The password is only in the server's `.env`.
- Built from `db/*.sql` in order. There is no `nipunacrm-dev` on the server.
- Holds the first Founder / CEO login (`flask create-admin`, a real email) **plus the staging test data** (the 20 accounts in [STAGING_ACCOUNTS.md](STAGING_ACCOUNTS.md), 8 courses, 20 leads, 5 admissions). The data was loaded on 27 Sep 2026 at the owner's request by running the seeder class directly, because `flask seed-dev` refuses any database not named `*-dev` or that already has users:
  ```bash
  cd /srv/nipuna/backend && APP_ENV=production ../venv/bin/python -c \
    "from app import create_app; from cli.seed import Seeder; app = create_app(); app.app_context().push(); Seeder().run()"
  ```
  The pre-seed backup is `/srv/nipuna/backups/nipunacrm-before-seed-2026-09-27-2321.dump`. Don't run it again: the accounts already exist, so a second run fails.
- ⚠️ The staging password is in the repo and the site is public, so anyone with the URL can log in as `founder@nipuna.test`. Fine for fictional test data only. Before any real data goes in, restore the backup or deactivate these accounts.

---

## 2. Redeploy code

Run from the repo root on your laptop. **Check the account first** (see the box at the top), then:

```bash
IP=<current public IP>
KEY="ssh -i $HOME/.ssh/nipuna-crm-test"

# 1. Build the frontend locally — the 1 GB server does not build it
(cd frontend && npm run build)

# 2. Upload (never the local .env, caches, uploads or tests)
rsync -az --delete -e "$KEY" --exclude '.env' --exclude '__pycache__' --exclude '.pytest_cache' \
  --exclude 'uploads/' --exclude 'tests/' --exclude 'api.http' backend db ubuntu@$IP:/srv/nipuna/
rsync -az --delete -e "$KEY" frontend/dist/ ubuntu@$IP:/srv/nipuna/frontend/

# 3. If requirements.txt changed
$KEY ubuntu@$IP '/srv/nipuna/venv/bin/pip install -q -r /srv/nipuna/backend/requirements.txt'

# 4. Restart the API
$KEY ubuntu@$IP 'sudo systemctl restart nipuna && systemctl is-active nipuna'
```

### New migrations

There is no migrations table, so **apply only the new files, once each, in order**. Take a backup first (section 4). Replaying an old file will fail or duplicate data.

```bash
$KEY ubuntu@$IP 'cd /srv/nipuna && set -a && . backend/.env && set +a &&
  psql "${DATABASE_URL/+psycopg/}" -v ON_ERROR_STOP=1 --single-transaction -f db/017_<name>.sql'
```

Applied so far: `001` to `016`.

**Pending for the V4 review deploy (not applied yet — only on the user's go-ahead):** `017` to `022`, in order, each with `--single-transaction`. Take a `pg_dump` backup first (section 4): 019–022 rewrite the pipeline, invoice and payment triggers and backfill existing rows (one-line invoices, payment allocations, transaction numbers; pending receipts lose their receipt numbers until verified). All six were rehearsed on a copy of the local main database and replayed from scratch against `nipunacrm-dev` (schema diff 0). The staging seed on the server predates V4; reload it only if asked (`create-dev-db` refuses non-dev names, so it would be a manual rebuild).

---

## 3. Check it works

```bash
URL=https://${IP//./-}.sslip.io
curl -s -o /dev/null -w "%{http_code}\n" $URL/          # 200
curl -s -o /dev/null -w "%{http_code}\n" $URL/leads     # 200 (SPA deep link)
$KEY ubuntu@$IP 'sudo certbot certificates'              # certificate + expiry
$KEY ubuntu@$IP 'sudo journalctl -u nipuna -n 50 --no-pager'  # API logs
$KEY ubuntu@$IP 'tail -20 /srv/nipuna/jobs.log'              # background jobs
$KEY ubuntu@$IP 'free -h; df -h /'                           # memory / disk
```

---

## 4. Backups

The database lives on the instance disk. It survives stop/start but is **lost if the instance is terminated**.

```bash
# Dump to your laptop
$KEY ubuntu@$IP 'cd /srv/nipuna && set -a && . backend/.env && set +a && pg_dump -Fc "${DATABASE_URL/+psycopg/}"' \
  > nipunacrm-$(date +%F).dump
```

For a whole-disk copy, take an EBS snapshot (check the account first).

---

## 5. Stop, start and IP changes

Stop the instance when it isn't needed. While stopped, only the disk is billed (~$1.80/month).

```bash
aws sts get-caller-identity --profile nipuna --query Account --output text   # must be 307857432997
aws ec2 stop-instances  --profile nipuna --instance-ids i-0f56f0778b34411e7
aws ec2 start-instances --profile nipuna --instance-ids i-0f56f0778b34411e7
```

- **The public IP changes after every start, and with it the HTTPS hostname.** Look up the new IP (section 1), then issue a certificate for the new name:
  ```bash
  NEW=${IP//./-}.sslip.io
  $KEY ubuntu@$IP "sudo sed -i 's/[0-9-]*\.sslip\.io/$NEW/g' /etc/nginx/sites-available/nipuna &&
    sudo certbot --nginx -d $NEW --non-interactive --agree-tos --register-unsafely-without-email --redirect"
  ```
  Delete the old certificate afterwards with `sudo certbot delete --cert-name <old-name>`. Share the new URL `https://$NEW`.
- **SSH is limited to one IP.** If your own IP changes, SSH times out. Update the rule:
  ```bash
  aws ec2 authorize-security-group-ingress --profile nipuna --group-id sg-02132530c3cbda43c \
    --protocol tcp --port 22 --cidr $(curl -s https://checkip.amazonaws.com)/32
  ```
  Remove the old IP's rule afterwards with `revoke-security-group-ingress`.

---

## 6. Not set up yet

| Gap | Note |
|---|---|
| AI Copilot | No `ANTHROPIC_API_KEY` in the server `.env`, so the rule-based fallback is used |
| Fixed address | No Elastic IP or domain, so the URL and certificate change on restart. For a stable address: own domain + Elastic IP, then the same certbot command |
| Automated backups | Manual `pg_dump` only |

---

## 7. Building a new server from scratch

This is how the current one was built (27 Sep 2026). Check the account first.

1. Import the key pair `nipuna-crm-test` from `~/.ssh/nipuna-crm-test.pub`. Create security group `nipuna-crm-test` in the default VPC with 22 from your IP and 80 from `0.0.0.0/0`.
2. Launch a t3.micro from the Ubuntu 24.04 AMI (SSM parameter `/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id`), 20 GB gp3, `--associate-public-ip-address`, tags `Name=nipuna-crm-test`, `project=nipuna-crm`.
3. On the server: add a 2 GB swapfile, set the timezone to Asia/Kolkata, install `python3-venv nginx rsync`, and install `postgresql-18` from the PGDG repo (`/usr/share/postgresql-common/pgdg/apt.postgresql.org.sh`).
4. Create role `nipuna` (random password) and database `nipunacrm OWNER nipuna`. Write `backend/.env` on the server with a random `SECRET_KEY`.
5. Upload code (section 2), apply every `db/*.sql` in order with `--single-transaction`, and create the venv with `requirements.txt` + `gunicorn`.
6. Install `nipuna.service`, the nginx site (remove `sites-enabled/default`) and the jobs crontab line.
7. HTTPS: open 443 in the security group, set `server_name <dashed-ip>.sslip.io` in the nginx site, install `certbot python3-certbot-nginx`, then run the `certbot --nginx ... --redirect` command from section 5.
8. `APP_ENV=production flask --app app create-admin --role FOUNDER_CEO` for the first login. Share the password privately, and change it after the first login.
