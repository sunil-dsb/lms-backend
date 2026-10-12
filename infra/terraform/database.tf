
variable "db_instance_class" {
  description = "RDS instance size"
  type        = string
  default     = "db.t3.micro"
}

variable "db_engine_version" {
  description = "PostgreSQL major version"
  type        = string
  default     = "17"
}

variable "db_allocated_storage" {
  description = "Initial database storage in GB"
  type        = number
  default     = 20
}

variable "db_max_allocated_storage" {
  description = "Upper limit in GB for storage autoscaling"
  type        = number
  default     = 100
}

variable "db_name" {
  description = "Name of the application database"
  type        = string
  default     = "lms"
}

variable "db_username" {
  description = "Master username"
  type        = string
  default     = "lms_admin"
}

variable "db_multi_az" {
  description = "Run a standby replica in a second availability zone"
  type        = bool
  default     = false
}

variable "db_backup_retention_days" {
  description = "Days of automated backups to keep"
  type        = number
  default     = 7
}

variable "db_deletion_protection" {
  description = "Block deletion of the database. Set to false and apply before a terraform destroy."
  type        = bool
  default     = true
}

resource "aws_db_subnet_group" "main" {
  name       = local.name
  subnet_ids = aws_subnet.database[*].id

  tags = local.tags
}

resource "aws_security_group" "database" {
  name        = "${local.name}-db"
  description = "PostgreSQL, reachable only from the LMS API host"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "PostgreSQL from the API host"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }

  tags = merge(local.tags, { Name = "${local.name}-db" })
}

# Letters and digits only, so the password needs no escaping in DATABASE_URL.
resource "random_password" "db" {
  length  = 32
  special = false
}

resource "aws_db_instance" "main" {
  identifier = local.name

  engine                     = "postgres"
  engine_version             = var.db_engine_version
  auto_minor_version_upgrade = true
  instance_class             = var.db_instance_class

  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = var.db_max_allocated_storage
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name  = var.db_name
  username = var.db_username
  password = random_password.db.result
  port     = 5432

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.database.id]
  publicly_accessible    = false
  multi_az               = var.db_multi_az

  backup_retention_period = var.db_backup_retention_days
  copy_tags_to_snapshot   = true

  deletion_protection       = var.db_deletion_protection
  skip_final_snapshot       = false
  final_snapshot_identifier = "${local.name}-final"

  tags = local.tags

  lifecycle {
    # The major version is pinned above; AWS applies minor upgrades itself.
    ignore_changes = [engine_version]
  }
}
