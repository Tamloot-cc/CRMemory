# Three functions from one package (build.sh):
#   api          REST, MCP and the web app, behind API Gateway
#   consolidate  one consolidator pass, on a schedule
#   ops          migrations and the operator CLI, invoked by deploy.sh and ops.sh
#
# Terraform creates them with the package at package_path and then ignores
# their code and their reserved concurrency: deploy.sh ships new versions and
# stops and starts the functions, so the order of stopping the API,
# migrating and starting it again lives in one place, and an apply never
# restarts functions a failed deploy left stopped.

resource "random_id" "suppression_key" {
  byte_length = 32 # 64 hex characters; RETAINER_SUPPRESSION_KEY needs 32+
}

resource "aws_iam_role" "functions" {
  name = "${var.name}-functions"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

# Logs, and the network interfaces a function in a VPC needs. Nothing else:
# the functions call no AWS API.
resource "aws_iam_role_policy_attachment" "functions_vpc" {
  role       = aws_iam_role.functions.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

locals {
  public_origin = (
    var.domain_name != null && var.domain_certificate_validated
    ? "https://${var.domain_name}"
    : aws_apigatewayv2_api.this.api_endpoint
  )

  # Each function gets only the database login it needs (database.tf).
  common_env = {
    LOG_LEVEL    = var.log_level
    NODE_OPTIONS = "--enable-source-maps"
  }

  functions = {
    api = {
      handler     = "dist/lambda/api.handler"
      memory      = var.api_memory_mb
      timeout     = 29 # API Gateway's own limit is 30 seconds
      concurrency = var.api_reserved_concurrency
      env = {
        RETAINER_RUNTIME_DATABASE_URL = local.runtime_database_url
        RETAINER_PUBLIC_ORIGIN        = local.public_origin
        RETAINER_SUPPRESSION_KEY      = random_id.suppression_key.hex
        RETAINER_WEB_DIR              = "/var/task/web"
        RETAINER_DB_POOL_MAX          = tostring(var.api_db_pool_max)
      }
    }
    consolidate = {
      handler     = "dist/lambda/consolidate.handler"
      memory      = 512
      timeout     = 300
      concurrency = 1
      env = {
        RETAINER_RUNTIME_DATABASE_URL         = local.runtime_database_url
        RETAINER_CONSOLIDATE_INTERVAL_MINUTES = tostring(var.consolidate_interval_minutes)
      }
    }
    ops = {
      handler     = "dist/lambda/ops.handler"
      memory      = 512
      timeout     = 900 # a migration may rewrite large tables
      concurrency = 1   # never two migrations at once
      env = {
        DATABASE_URL = local.database_url
        # Read only to set retainer_app's password when migrating.
        RETAINER_RUNTIME_DATABASE_URL = local.runtime_database_url
      }
    }
  }
}

resource "aws_cloudwatch_log_group" "functions" {
  for_each          = local.functions
  name              = "/aws/lambda/${var.name}-${each.key}"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "this" {
  for_each = local.functions

  function_name = "${var.name}-${each.key}"
  role          = aws_iam_role.functions.arn
  runtime       = "nodejs22.x"
  architectures = ["arm64"]
  handler       = each.value.handler
  memory_size   = each.value.memory
  timeout       = each.value.timeout

  # Read only when creating a function (code changes are ignored below), so
  # plan, apply and destroy work from a checkout without a build.
  filename         = var.package_path
  source_code_hash = fileexists(var.package_path) ? filebase64sha256(var.package_path) : null

  reserved_concurrent_executions = each.value.concurrency

  vpc_config {
    subnet_ids         = aws_subnet.private[*].id
    security_group_ids = [aws_security_group.functions.id]
  }

  environment {
    variables = merge(local.common_env, each.value.env)
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.functions[each.key].name
  }

  # deploy.sh stops the API by setting its concurrency to 0 and restores it
  # from this tag, so a deploy that failed halfway cannot leave the wrong
  # value behind as the "previous" one. A changed concurrency setting takes
  # effect at the next deploy.
  tags = {
    "retainer:reserved-concurrency" = tostring(each.value.concurrency)
  }

  lifecycle {
    ignore_changes = [filename, source_code_hash, reserved_concurrent_executions]
  }

  depends_on = [aws_iam_role_policy_attachment.functions_vpc]
}
