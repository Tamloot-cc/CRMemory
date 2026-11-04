# A VPC of its own with two private subnets and no internet gateway or NAT:
# the database is reachable only from the functions, and Retainer makes no
# outbound calls (it never calls a model or any other service), so the
# functions need no route out. API Gateway reaches them through Lambda.

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  azs = slice(data.aws_availability_zones.available.names, 0, 2)
}

resource "aws_vpc" "this" {
  cidr_block           = "10.42.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = var.name }
}

# The VPC's default security group allows all traffic between its members.
# Nothing uses it; strip its rules so nothing can by accident.
resource "aws_default_security_group" "this" {
  vpc_id = aws_vpc.this.id
}

resource "aws_subnet" "private" {
  count             = length(local.azs)
  vpc_id            = aws_vpc.this.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(aws_vpc.this.cidr_block, 8, count.index)

  tags = { Name = "${var.name}-private-${local.azs[count.index]}" }
}

resource "aws_security_group" "functions" {
  name        = "${var.name}-functions"
  description = "Retainer functions: may reach the database only"
  vpc_id      = aws_vpc.this.id
}

resource "aws_vpc_security_group_egress_rule" "functions_to_database" {
  security_group_id            = aws_security_group.functions.id
  referenced_security_group_id = aws_security_group.database.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "Postgres"
}

resource "aws_security_group" "database" {
  name        = "${var.name}-database"
  description = "Retainer database: reachable from the functions only"
  vpc_id      = aws_vpc.this.id
}

resource "aws_vpc_security_group_ingress_rule" "database_from_functions" {
  security_group_id            = aws_security_group.database.id
  referenced_security_group_id = aws_security_group.functions.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "Postgres from the functions"
}
