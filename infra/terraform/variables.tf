variable "aws_region" {
  description = "AWS region for production infrastructure"
  type        = string
  default     = "ca-central-1"
}

variable "aws_profile" {
  description = "Named AWS CLI profile to run Terraform with. Leave null to use the default credential chain (environment variables, AWS_PROFILE, ...)."
  type        = string
  default     = null
}

variable "project" {
  description = "Project name, used as a prefix for resource names and the SSM path"
  type        = string
  default     = "lms-backend"
}

variable "environment" {
  description = "Environment name"
  type        = string
  default     = "production"
}

# --- Application ---

variable "api_domain" {
  description = "Public DNS name of the API (e.g. api.example.com). Leave empty to serve plain HTTP on the Elastic IP until DNS is ready."
  type        = string
  default     = ""
}

variable "certbot_email" {
  description = "Contact email for the Let's Encrypt certificate. Only used when api_domain is set."
  type        = string
  default     = ""
}

variable "frontend_base_url" {
  description = "Origin of the web frontend (e.g. https://app.example.com). Used for CORS, trusted origins and email links."
  type        = string
}
