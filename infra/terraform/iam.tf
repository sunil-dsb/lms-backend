
# --- GitHub Actions deploy role: may run one SSM command on the app host ---

data "aws_iam_policy_document" "github_deploy_ssm" {
  statement {
    sid       = "SendDeploymentCommandsToTaggedInstance"
    effect    = "Allow"
    actions   = ["ssm:SendCommand"]
    resources = ["arn:${data.aws_partition.current.partition}:ssm:${var.aws_region}::document/AWS-RunShellScript"]
  }

  statement {
    sid    = "TargetOnlyDeploymentInstances"
    effect = "Allow"
    actions = [
      "ssm:SendCommand"
    ]

    resources = ["arn:${data.aws_partition.current.partition}:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:instance/*"]

    condition {
      test     = "StringEquals"
      variable = "ssm:resourceTag/DeploymentTarget"
      values   = [local.name]
    }
  }

  statement {
    sid    = "ReadCommandStatus"
    effect = "Allow"
    actions = [
      "ssm:GetCommandInvocation",
      "ssm:ListCommandInvocations"
    ]

    resources = ["*"]
  }

  # The workflow hands its short-lived GITHUB_TOKEN to the host through this
  # one parameter so the host can pull the image from GHCR.
  statement {
    sid       = "WriteRegistryPullToken"
    effect    = "Allow"
    actions   = ["ssm:PutParameter"]
    resources = [aws_ssm_parameter.ghcr_token.arn]
  }

  statement {
    sid       = "EncryptRegistryPullToken"
    effect    = "Allow"
    actions   = ["kms:Encrypt", "kms:GenerateDataKey"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${var.aws_region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "github_deploy_ssm" {
  name   = "ssm-deploy"
  role   = aws_iam_role.github_deploy.id
  policy = data.aws_iam_policy_document.github_deploy_ssm.json
}

# --- EC2 instance role: SSM agent + read its own configuration ---

resource "aws_iam_role" "ec2" {
  name = "${local.name}-ec2"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "ec2.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })

  tags = local.tags
}

resource "aws_iam_role_policy_attachment" "ec2_ssm_core" {
  role       = aws_iam_role.ec2.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "ec2_read_config" {
  statement {
    sid    = "ReadOwnParameters"
    effect = "Allow"
    actions = [
      "ssm:GetParameter",
      "ssm:GetParameters",
      "ssm:GetParametersByPath"
    ]
    resources = [
      local.ssm_parameter_arn_prefix,
      "${local.ssm_parameter_arn_prefix}/*"
    ]
  }

  statement {
    sid       = "DecryptOwnParameters"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${var.aws_region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "ec2_read_config" {
  name   = "read-config"
  role   = aws_iam_role.ec2.id
  policy = data.aws_iam_policy_document.ec2_read_config.json
}

resource "aws_iam_instance_profile" "ec2" {
  name = "${local.name}-ec2"
  role = aws_iam_role.ec2.name
}
