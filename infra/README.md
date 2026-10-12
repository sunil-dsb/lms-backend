# Infrastructure and deployment

How the LMS API gets from a push on `main` to a running container on AWS.

```
push to main
  -> CI (.github/workflows/ci.yml)
       typecheck, lint, build, gitleaks, Trivy image scan
       publish ghcr.io/<owner>/<repo>:sha-<commit>
  -> Deploy (.github/workflows/deploy.yaml)
       assume an AWS role through GitHub OIDC (no stored AWS keys)
       send scripts/deploy.sh to the EC2 host over SSM (no SSH)
  -> EC2 host
       read config from SSM Parameter Store, pull the image,
       run migrations against RDS, start the idle blue/green slot,
       switch Nginx to it
```

## What Terraform creates (`infra/terraform`)

| File          | Resources                                                                                 |
| ------------- | ----------------------------------------------------------------------------------------- |
| `network.tf`  | VPC, one public subnet (EC2), two private subnets (RDS)                                   |
| `compute.tf`  | EC2 host (Amazon Linux 2023, Docker, Nginx, certbot), security group, Elastic IP          |
| `database.tf` | RDS PostgreSQL, private, encrypted, reachable only from the EC2 security group            |
| `oidc.tf`     | GitHub OIDC provider and the deploy role, limited to the `main` branch of this repo       |
| `iam.tf`      | Deploy role policy (one SSM command on the tagged host), EC2 role (SSM + read own config) |
| `ssm.tf`      | `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `FRONTEND_BASE_URL` parameters   |

## First-time setup

1. Install Terraform (1.5 or newer) and the AWS CLI, and sign in to the target AWS account.
2. Create the variables file and review it:
   ```
   cd infra/terraform
   cp terraform.tfvars.example terraform.tfvars
   ```
3. Apply:
   ```
   terraform init
   terraform plan
   terraform apply
   ```
4. In GitHub, under Settings - Secrets and variables - Actions - Variables, add `AWS_ROLE_ARN` with the `github_deploy_role_arn` output. Add `AWS_REGION` too if the region is not `ca-central-1`.
5. Add the secrets Terraform does not manage (only the ones the app needs, see the env table in the root README):
   ```
   aws ssm put-parameter --type SecureString --name /lms-backend/production/env/RESEND_API_KEY --value "..."
   aws ssm put-parameter --type SecureString --name /lms-backend/production/env/R2_ACCOUNT_ID --value "..."
   aws ssm put-parameter --type SecureString --name /lms-backend/production/env/R2_ACCESS_KEY_ID --value "..."
   aws ssm put-parameter --type SecureString --name /lms-backend/production/env/R2_SECRET_ACCESS_KEY --value "..."
   aws ssm put-parameter --type String --name /lms-backend/production/env/R2_BUCKET --value "..."
   aws ssm put-parameter --type String --name /lms-backend/production/env/R2_PUBLIC_BASE_URL --value "..."
   ```
   Every parameter under `/lms-backend/production/env/` becomes an environment variable of the container on the next deployment.
6. Run the "Verify AWS OIDC" workflow by hand once to confirm GitHub can assume the role.
7. Push to `main`. CI publishes the image and the deploy workflow releases it.

## HTTPS

The app sets `Secure` cookies in production, so sign-in only works over HTTPS.

1. Create an A record for the API domain pointing at the `ec2_public_ip` output.
2. Set `api_domain` and `certbot_email` in `terraform.tfvars` and run `terraform apply`.
3. Re-run the deploy workflow (or push). The deploy script requests a Let's Encrypt certificate and switches Nginx to HTTPS. Renewal is handled by `certbot-renew.timer` on the host.

Until the certificate exists the API is served over plain HTTP on the Elastic IP, which is enough to check `/health` and `/health/db` but not to sign in.

## Operations

Open a shell on the host (there is no SSH):

```
aws ssm start-session --target <ec2_instance_id>
```

- Roll back to the previous slot: `sudo bash /opt/lms-backend/release/scripts/rollback.sh`
- Logs: `sudo docker logs -f lms-backend-$(sudo cat /opt/lms-backend/active-color)`
- Change a config value: update the SSM parameter, then re-run the deploy workflow.

The database is private. To reach it from a laptop (for example to seed it), forward a port through the host:

```
aws ssm start-session --target <ec2_instance_id> \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters host=<db host from db_endpoint>,portNumber=5432,localPortNumber=5433
```

## Things to know

- Terraform state is local (`terraform.tfstate`, gitignored) and contains the database password. Keep it safe, or move it to an S3 backend before more than one person applies.
- Migrations run on every deployment, before traffic switches, while the old container is still serving. A migration must not break the release before it.
- The RDS instance has deletion protection. Set `db_deletion_protection = false` and apply before `terraform destroy`.
- The EC2 instance ignores AMI and `user_data` changes so an apply never rebuilds it by surprise. To rebuild: `terraform apply -replace=aws_instance.app`, then redeploy.
