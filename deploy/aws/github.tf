# The role the Deploy to AWS workflow assumes to run terraform apply and then
# deploy.sh. It can manage what this stack creates, scoped by `name` where
# AWS has names in its ARNs and by region where it has not (EC2, API
# Gateway). It cannot change its own permissions: an edit to this file is
# applied by an operator with terraform apply, before the workflow can use it.
#
# Only jobs running in the GitHub Environment `production` of
# `github_repository` can assume it: the name .github/workflows/deploy-aws.yml
# uses, so the two cannot disagree. Restrict that environment to the default
# branch, so pull requests (including from forks) never can.

# The account's OIDC provider for GitHub Actions is a prerequisite, not part
# of this deployment: an account holds one per issuer, shared by every
# repository's roles, so destroying a deployment must never delete it.
# docs/aws.md has the one command that creates it where it is missing.
data "aws_iam_openid_connect_provider" "github" {
  count = var.github_repository != null ? 1 : 0
  url   = "https://token.actions.githubusercontent.com"
}

locals {
  github_oidc_provider_arn = one(data.aws_iam_openid_connect_provider.github[*].arn)
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
          "token.actions.githubusercontent.com:sub" = "${coalesce(var.github_subject_prefix, "repo:${var.github_repository}")}:environment:production"
        }
      }
    }]
  })
}

locals {
  github_deploy = var.github_repository == null ? null : {
    account = data.aws_caller_identity.current.account_id
    region  = var.region
    # The bucket and key state-bucket.sh creates and prints.
    state_bucket = "${var.name}-terraform-state-${data.aws_caller_identity.current.account_id}"
    state_key    = "${var.name}/${var.region}/terraform.tfstate"
  }
}

resource "aws_iam_role_policy" "github_deploy" {
  count = var.github_repository != null ? 1 : 0
  name  = "terraform-and-deploy"
  role  = aws_iam_role.github_deploy[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "TerraformState"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = "arn:aws:s3:::${local.github_deploy.state_bucket}"
      },
      {
        Sid    = "TerraformStateAndLock"
        Effect = "Allow"
        Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = [
          "arn:aws:s3:::${local.github_deploy.state_bucket}/${local.github_deploy.state_key}",
          "arn:aws:s3:::${local.github_deploy.state_bucket}/${local.github_deploy.state_key}.tflock",
        ]
      },
      {
        Sid    = "Read"
        Effect = "Allow"
        Action = [
          "ec2:Describe*",
          "rds:Describe*",
          "logs:DescribeLogGroups",
          "logs:DescribeResourcePolicies",
          "logs:ListLogDeliveries",
          "cloudwatch:DescribeAlarms",
        ]
        Resource  = "*"
        Condition = { StringEquals = { "aws:RequestedRegion" = local.github_deploy.region } }
      },
      {
        Sid    = "Functions"
        Effect = "Allow"
        Action = [
          "lambda:CreateFunction",
          "lambda:DeleteFunction",
          "lambda:Get*",
          "lambda:List*",
          "lambda:TagResource",
          "lambda:UntagResource",
          "lambda:UpdateFunctionCode",
          "lambda:UpdateFunctionConfiguration",
          "lambda:PutFunctionConcurrency",
          "lambda:DeleteFunctionConcurrency",
          "lambda:AddPermission",
          "lambda:RemovePermission",
          "lambda:InvokeFunction",
        ]
        Resource = "arn:aws:lambda:${local.github_deploy.region}:${local.github_deploy.account}:function:${var.name}-*"
      },
      {
        Sid    = "FunctionRole"
        Effect = "Allow"
        Action = [
          "iam:CreateRole",
          "iam:DeleteRole",
          "iam:GetRole",
          "iam:UpdateRole",
          "iam:UpdateAssumeRolePolicy",
          "iam:TagRole",
          "iam:UntagRole",
          "iam:ListRoleTags",
          "iam:ListRolePolicies",
          "iam:GetRolePolicy",
          "iam:ListAttachedRolePolicies",
          "iam:ListInstanceProfilesForRole",
        ]
        Resource = aws_iam_role.functions.arn
      },
      {
        Sid       = "FunctionRolePolicy"
        Effect    = "Allow"
        Action    = ["iam:AttachRolePolicy", "iam:DetachRolePolicy"]
        Resource  = aws_iam_role.functions.arn
        Condition = { ArnEquals = { "iam:PolicyARN" = aws_iam_role_policy_attachment.functions_vpc.policy_arn } }
      },
      {
        Sid       = "PassFunctionRole"
        Effect    = "Allow"
        Action    = "iam:PassRole"
        Resource  = aws_iam_role.functions.arn
        Condition = { StringEquals = { "iam:PassedToService" = "lambda.amazonaws.com" } }
      },
      {
        # Terraform reads this role and its policy; changing them is an
        # operator's apply.
        Sid    = "ReadOwnRole"
        Effect = "Allow"
        Action = [
          "iam:GetRole",
          "iam:GetRolePolicy",
          "iam:ListRolePolicies",
          "iam:ListAttachedRolePolicies",
          "iam:ListRoleTags",
        ]
        Resource = aws_iam_role.github_deploy[0].arn
      },
      {
        Sid      = "ReadGitHubOidcProvider"
        Effect   = "Allow"
        Action   = ["iam:ListOpenIDConnectProviders", "iam:GetOpenIDConnectProvider"]
        Resource = "*"
      },
      {
        # EC2 has no names in its ARNs: these are limited to the region.
        Sid    = "Network"
        Effect = "Allow"
        Action = [
          "ec2:CreateVpc",
          "ec2:DeleteVpc",
          "ec2:ModifyVpcAttribute",
          "ec2:CreateSubnet",
          "ec2:DeleteSubnet",
          "ec2:ModifySubnetAttribute",
          "ec2:CreateSecurityGroup",
          "ec2:DeleteSecurityGroup",
          "ec2:AuthorizeSecurityGroupIngress",
          "ec2:AuthorizeSecurityGroupEgress",
          "ec2:RevokeSecurityGroupIngress",
          "ec2:RevokeSecurityGroupEgress",
          "ec2:ModifySecurityGroupRules",
          "ec2:UpdateSecurityGroupRuleDescriptionsIngress",
          "ec2:UpdateSecurityGroupRuleDescriptionsEgress",
          "ec2:CreateInternetGateway",
          "ec2:DeleteInternetGateway",
          "ec2:AttachInternetGateway",
          "ec2:DetachInternetGateway",
          "ec2:CreateRouteTable",
          "ec2:DeleteRouteTable",
          "ec2:CreateRoute",
          "ec2:ReplaceRoute",
          "ec2:DeleteRoute",
          "ec2:AssociateRouteTable",
          "ec2:DisassociateRouteTable",
          "ec2:ReplaceRouteTableAssociation",
          "ec2:AllocateAddress",
          "ec2:ReleaseAddress",
          "ec2:DisassociateAddress",
          "ec2:CreateNatGateway",
          "ec2:DeleteNatGateway",
          "ec2:DeleteNetworkInterface",
          "ec2:CreateTags",
          "ec2:DeleteTags",
        ]
        Resource  = "*"
        Condition = { StringEquals = { "aws:RequestedRegion" = local.github_deploy.region } }
      },
      {
        Sid    = "Database"
        Effect = "Allow"
        Action = [
          "rds:CreateDBInstance",
          "rds:ModifyDBInstance",
          "rds:DeleteDBInstance",
          "rds:CreateDBSnapshot",
          "rds:CreateDBSubnetGroup",
          "rds:ModifyDBSubnetGroup",
          "rds:DeleteDBSubnetGroup",
          "rds:AddTagsToResource",
          "rds:RemoveTagsFromResource",
          "rds:ListTagsForResource",
        ]
        Resource = [
          "arn:aws:rds:${local.github_deploy.region}:${local.github_deploy.account}:db:${var.name}",
          "arn:aws:rds:${local.github_deploy.region}:${local.github_deploy.account}:subgrp:${var.name}",
          "arn:aws:rds:${local.github_deploy.region}:${local.github_deploy.account}:snapshot:${var.name}-final-*",
          # The default parameter and option groups a new instance uses.
          "arn:aws:rds:${local.github_deploy.region}:${local.github_deploy.account}:pg:default.*",
          "arn:aws:rds:${local.github_deploy.region}:${local.github_deploy.account}:og:default:*",
        ]
      },
      {
        # HTTP APIs have generated IDs: limited to the region's APIs and
        # this deployment's domain.
        Sid    = "Api"
        Effect = "Allow"
        Action = ["apigateway:GET", "apigateway:POST", "apigateway:PUT", "apigateway:PATCH", "apigateway:DELETE"]
        Resource = concat(
          [
            "arn:aws:apigateway:${local.github_deploy.region}::/apis",
            "arn:aws:apigateway:${local.github_deploy.region}::/apis/*",
            "arn:aws:apigateway:${local.github_deploy.region}::/tags/*",
          ],
          var.domain_name == null ? [] : [
            "arn:aws:apigateway:${local.github_deploy.region}::/domainnames",
            "arn:aws:apigateway:${local.github_deploy.region}::/domainnames/${var.domain_name}",
            "arn:aws:apigateway:${local.github_deploy.region}::/domainnames/${var.domain_name}/*",
          ],
        )
      },
      {
        Sid    = "Logs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:DeleteLogGroup",
          "logs:PutRetentionPolicy",
          "logs:DeleteRetentionPolicy",
          "logs:TagResource",
          "logs:UntagResource",
          "logs:ListTagsForResource",
          "logs:TagLogGroup",
          "logs:UntagLogGroup",
          "logs:ListTagsLogGroup",
        ]
        Resource = flatten([
          for group in ["/aws/lambda/${var.name}-*", "/aws/apigateway/${var.name}"] : [
            "arn:aws:logs:${local.github_deploy.region}:${local.github_deploy.account}:log-group:${group}",
            "arn:aws:logs:${local.github_deploy.region}:${local.github_deploy.account}:log-group:${group}:*",
          ]
        ])
      },
      {
        # API Gateway's access log, and a new certificate: these take no
        # resource.
        Sid    = "AccessLogAndCertificate"
        Effect = "Allow"
        Action = [
          "logs:CreateLogDelivery",
          "logs:GetLogDelivery",
          "logs:UpdateLogDelivery",
          "logs:DeleteLogDelivery",
          "logs:PutResourcePolicy",
          "acm:RequestCertificate",
        ]
        Resource  = "*"
        Condition = { StringEquals = { "aws:RequestedRegion" = local.github_deploy.region } }
      },
      {
        Sid    = "Alarms"
        Effect = "Allow"
        Action = [
          "cloudwatch:PutMetricAlarm",
          "cloudwatch:DeleteAlarms",
          "cloudwatch:TagResource",
          "cloudwatch:UntagResource",
          "cloudwatch:ListTagsForResource",
        ]
        Resource = "arn:aws:cloudwatch:${local.github_deploy.region}:${local.github_deploy.account}:alarm:${var.name}-*"
      },
      {
        Sid    = "AlarmTopic"
        Effect = "Allow"
        Action = [
          "sns:CreateTopic",
          "sns:DeleteTopic",
          "sns:GetTopicAttributes",
          "sns:SetTopicAttributes",
          "sns:TagResource",
          "sns:UntagResource",
          "sns:ListTagsForResource",
          "sns:Subscribe",
          "sns:Unsubscribe",
          "sns:GetSubscriptionAttributes",
          "sns:SetSubscriptionAttributes",
          "sns:ListSubscriptionsByTopic",
        ]
        # The topic, and its subscriptions (<topic ARN>:<id>).
        Resource = "arn:aws:sns:${local.github_deploy.region}:${local.github_deploy.account}:${var.name}-*"
      },
      {
        Sid    = "Schedule"
        Effect = "Allow"
        Action = [
          "events:PutRule",
          "events:DeleteRule",
          "events:DescribeRule",
          "events:EnableRule",
          "events:DisableRule",
          "events:PutTargets",
          "events:RemoveTargets",
          "events:ListTargetsByRule",
          "events:TagResource",
          "events:UntagResource",
          "events:ListTagsForResource",
        ]
        Resource = "arn:aws:events:${local.github_deploy.region}:${local.github_deploy.account}:rule/${var.name}-*"
      },
      {
        Sid    = "Certificate"
        Effect = "Allow"
        Action = [
          "acm:DescribeCertificate",
          "acm:DeleteCertificate",
          "acm:AddTagsToCertificate",
          "acm:RemoveTagsFromCertificate",
          "acm:ListTagsForCertificate",
        ]
        Resource = "arn:aws:acm:${local.github_deploy.region}:${local.github_deploy.account}:certificate/*"
      },
    ]
  })
}
