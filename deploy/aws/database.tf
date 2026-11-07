# PostgreSQL on RDS. The master user is Retainer's migration role: it owns
# the tables, creates the pg_trgm, btree_gin and unaccent extensions and the
# retainer_app runtime role (drizzle/0001_security.sql). Only the ops
# function connects with it. The api and consolidate functions log in as
# retainer_app itself, and in accounts mode the control function as
# retainer_control, each with a password of its own that the ops function
# sets when it migrates, so none holds a credential that can become the owner.

resource "random_password" "database" {
  length  = 40
  special = false # used inside DATABASE_URL unencoded
}

resource "random_password" "runtime" {
  length  = 40
  special = false # used inside RETAINER_RUNTIME_DATABASE_URL unencoded
}

# Accounts mode: the control function's login, as retainer_control.
resource "random_password" "control" {
  count   = local.accounts ? 1 : 0
  length  = 40
  special = false # used inside RETAINER_CONTROL_DATABASE_URL unencoded
}

# Suffix for the final snapshot: RDS keeps it after the instance is deleted,
# so a deployment recreated under the same name needs a new name for its own.
# It changes with a new state or a new identifier. Terraform cannot tie it to
# the instance itself (that would be a cycle), so when you replace the
# instance by hand, replace it too:
#   terraform apply -replace=aws_db_instance.this -replace=random_id.final_snapshot
resource "random_id" "final_snapshot" {
  byte_length = 4
  keepers = {
    identifier = var.name
  }
}

resource "aws_db_subnet_group" "this" {
  name       = var.name
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_db_instance" "this" {
  identifier     = var.name
  engine         = "postgres"
  engine_version = var.db_engine_version
  instance_class = var.db_instance_class

  db_name  = "retainer"
  username = "retainer"
  password = random_password.database.result
  port     = 5432

  allocated_storage     = var.db_allocated_storage_gb
  max_allocated_storage = var.db_max_allocated_storage_gb
  storage_type          = "gp3"
  storage_encrypted     = true

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.database.id]
  publicly_accessible    = false
  multi_az               = var.db_multi_az

  backup_retention_period   = var.db_backup_retention_days
  backup_window             = "02:00-03:00"
  maintenance_window        = "sun:03:30-sun:04:30"
  copy_tags_to_snapshot     = true
  deletion_protection       = var.db_deletion_protection
  skip_final_snapshot       = false
  final_snapshot_identifier = "${var.name}-final-${random_id.final_snapshot.hex}"

  auto_minor_version_upgrade = true
  # Lets a change to db_engine_version upgrade the major version in place.
  allow_major_version_upgrade = true
  apply_immediately           = false
}

locals {
  # rds.force_ssl is on by default for PostgreSQL 15 and later.
  database_url = format(
    "postgres://%s:%s@%s:%d/%s?sslmode=require",
    aws_db_instance.this.username,
    random_password.database.result,
    aws_db_instance.this.address,
    aws_db_instance.this.port,
    aws_db_instance.this.db_name,
  )

  control_database_url = local.accounts ? format(
    "postgres://retainer_control:%s@%s:%d/%s?sslmode=require",
    one(random_password.control[*].result),
    aws_db_instance.this.address,
    aws_db_instance.this.port,
    aws_db_instance.this.db_name,
  ) : null

  runtime_database_url = format(
    "postgres://retainer_app:%s@%s:%d/%s?sslmode=require",
    random_password.runtime.result,
    aws_db_instance.this.address,
    aws_db_instance.this.port,
    aws_db_instance.this.db_name,
  )
}
