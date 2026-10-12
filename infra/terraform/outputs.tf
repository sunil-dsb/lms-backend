
output "github_deploy_role_arn" {
  description = "Set as the AWS_ROLE_ARN repository variable in GitHub"
  value       = aws_iam_role.github_deploy.arn
}

# The next three only need a GitHub repository variable of the same name
# (upper case) when they differ from the defaults in deploy.yaml.

output "aws_region" {
  description = "AWS_REGION repository variable. Workflow default: ca-central-1"
  value       = var.aws_region
}

output "deployment_target" {
  description = "DEPLOYMENT_TARGET repository variable. Workflow default: lms-backend-production"
  value       = aws_instance.app.tags["DeploymentTarget"]
}

output "ssm_prefix" {
  description = "SSM_PREFIX repository variable. Workflow default: /lms-backend/production. Also the path to add extra app secrets under (<prefix>/env/NAME)."
  value       = local.ssm_prefix
}

output "ec2_instance_id" {
  description = "Production EC2 instance ID"
  value       = aws_instance.app.id
}

output "ec2_public_ip" {
  description = "Elastic IP of the API host. Point the api_domain A record here."
  value       = aws_eip.app.public_ip
}

output "api_base_url" {
  description = "Public base URL of the API"
  value       = local.api_base_url
}

output "db_endpoint" {
  description = "RDS endpoint (private, reachable only from the API host)"
  value       = aws_db_instance.main.endpoint
}

output "vpc_id" {
  description = "Application VPC ID"
  value       = aws_vpc.main.id
}
