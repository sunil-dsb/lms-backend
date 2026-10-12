
# Runtime configuration for the API. scripts/deploy.sh reads every parameter
# under <prefix>/env and writes it to the container's env file, using the last
# path segment as the variable name.
#
# Terraform owns only the values it can derive. Third-party secrets
# (RESEND_API_KEY, R2_*, GOOGLE_AI_API_KEY, ...) are added to the same path by
# hand so they never pass through tfvars or Terraform state. See README.md.

resource "random_password" "better_auth_secret" {
  length  = 48
  special = false
}

locals {
  api_base_url = var.api_domain != "" ? "https://${var.api_domain}" : "http://${aws_eip.app.public_ip}"
}

resource "aws_ssm_parameter" "database_url" {
  name  = "${local.ssm_prefix}/env/DATABASE_URL"
  type  = "SecureString"
  value = "postgres://${aws_db_instance.main.username}:${random_password.db.result}@${aws_db_instance.main.address}:${aws_db_instance.main.port}/${aws_db_instance.main.db_name}"

  tags = local.tags
}

resource "aws_ssm_parameter" "better_auth_secret" {
  name  = "${local.ssm_prefix}/env/BETTER_AUTH_SECRET"
  type  = "SecureString"
  value = random_password.better_auth_secret.result

  tags = local.tags
}

resource "aws_ssm_parameter" "better_auth_url" {
  name  = "${local.ssm_prefix}/env/BETTER_AUTH_URL"
  type  = "String"
  value = local.api_base_url

  tags = local.tags
}

resource "aws_ssm_parameter" "frontend_base_url" {
  name  = "${local.ssm_prefix}/env/FRONTEND_BASE_URL"
  type  = "String"
  value = var.frontend_base_url

  tags = local.tags
}

# --- Settings for the deploy script ---

resource "aws_ssm_parameter" "domain" {
  count = var.api_domain != "" ? 1 : 0

  name  = "${local.ssm_prefix}/deploy/domain"
  type  = "String"
  value = var.api_domain

  tags = local.tags
}

resource "aws_ssm_parameter" "certbot_email" {
  count = var.certbot_email != "" ? 1 : 0

  name  = "${local.ssm_prefix}/deploy/certbot-email"
  type  = "String"
  value = var.certbot_email

  tags = local.tags
}

# Holds the workflow's short-lived GITHUB_TOKEN during a deployment. The deploy
# workflow overwrites the value on every run, so Terraform ignores it.
resource "aws_ssm_parameter" "ghcr_token" {
  name  = "${local.ssm_prefix}/deploy/ghcr-token"
  type  = "SecureString"
  value = "unset"

  tags = local.tags

  lifecycle {
    ignore_changes = [value]
  }
}
