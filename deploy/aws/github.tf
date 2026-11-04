# The role GitHub Actions assumes to ship code (deploy.sh). It can update,
# stop, start and invoke this deployment's functions and nothing else: no
# Terraform, no IAM, no database. Infrastructure changes are applied by an
# operator with terraform apply.
#
# Only jobs running in the GitHub Environment `github_environment` of
# `github_repository` can assume it. Restrict that environment to the
# default branch, so pull requests (including from forks) never can.

# An account has at most one provider for GitHub's issuer, often created by
# another project; look it up, or create it with create_github_oidc_provider.
data "aws_iam_openid_connect_provider" "github" {
  count = var.github_repository != null && !var.create_github_oidc_provider ? 1 : 0
  url   = "https://token.actions.githubusercontent.com"
}

resource "aws_iam_openid_connect_provider" "github" {
  count          = var.github_repository != null && var.create_github_oidc_provider ? 1 : 0
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

locals {
  github_oidc_provider_arn = one(concat(
    aws_iam_openid_connect_provider.github[*].arn,
    data.aws_iam_openid_connect_provider.github[*].arn,
  ))
}

resource "aws_iam_role" "github_deploy" {
  count = var.github_repository != null ? 1 : 0
  name  = "${var.name}-github-deploy"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = local.github_oidc_provider_arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = "repo:${var.github_repository}:environment:${var.github_environment}"
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "github_deploy" {
  count = var.github_repository != null ? 1 : 0
  name  = "ship-code"
  role  = aws_iam_role.github_deploy[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "lambda:GetFunction",
        "lambda:GetFunctionConfiguration",
        "lambda:ListTags",
        "lambda:UpdateFunctionCode",
        "lambda:PutFunctionConcurrency",
        "lambda:InvokeFunction",
      ]
      Resource = [for f in aws_lambda_function.this : f.arn]
    }]
  })
}
