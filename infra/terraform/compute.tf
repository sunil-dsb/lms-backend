
variable "instance_type" {
  description = "EC2 instance size"
  type        = string
  default     = "t3.micro"
}

data "aws_ami" "amazon_linux" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-2023.*-x86_64"]
  }

  filter {
    name   = "architecture"
    values = ["x86_64"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

resource "aws_security_group" "app" {
  name        = "${local.name}-app"
  description = "LMS API host; no direct SSH access"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "HTTP web traffic and certificate validation"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS for secure API traffic"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "Outbound access for updates, SSM, and image pulls"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.tags, { Name = "${local.name}-app" })
}

resource "aws_instance" "app" {
  ami                    = data.aws_ami.amazon_linux.id
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.app.id]
  iam_instance_profile   = aws_iam_instance_profile.ec2.name

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required"
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = 20
    encrypted             = true
    delete_on_termination = true
  }

  # The host only gets its base packages here. Application config, Nginx
  # site config and the containers are all put in place by scripts/deploy.sh,
  # which the deploy workflow ships over SSM on every release.
  user_data = <<-EOF
    #!/bin/bash
    set -euxo pipefail

    dnf update -y
    dnf install -y docker nginx certbot

    # Two containers run side by side during a blue-green switch; swap keeps
    # a small instance from running out of memory while both are up.
    if [ ! -f /swapfile ]; then
      dd if=/dev/zero of=/swapfile bs=1M count=1024
      chmod 600 /swapfile
      mkswap /swapfile
      swapon /swapfile
      echo '/swapfile none swap sw 0 0' >> /etc/fstab
    fi

    systemctl enable --now docker

    mkdir -p /opt/${var.project}
    mkdir -p /var/www/certbot
    mkdir -p /etc/nginx/upstreams

    systemctl enable --now nginx
    systemctl enable --now certbot-renew.timer || true
  EOF

  tags = merge(local.tags, {
    Name             = local.name
    DeploymentTarget = local.name
  })

  lifecycle {
    # A newer AMI or an edit to user_data must not replace or reboot the
    # running production host on the next apply. Taint the instance to rebuild.
    ignore_changes = [ami, user_data]
  }

  depends_on = [
    aws_iam_role_policy_attachment.ec2_ssm_core
  ]
}

# Stable public address, so DNS survives a stop/start or a rebuilt instance.
resource "aws_eip" "app" {
  domain   = "vpc"
  instance = aws_instance.app.id

  tags = merge(local.tags, { Name = local.name })

  depends_on = [aws_internet_gateway.main]
}
