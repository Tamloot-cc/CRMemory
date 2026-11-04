# PostgreSQL on RDS. The master user is Retainer's migration role: it owns
# the tables, creates the pg_trgm, btree_gin and unaccent extensions and the
# retainer_app runtime role (drizzle/0001_security.sql). The functions
# connect with it and switch to retainer_app, as the container does.

resource "random_password" "database" {
  length  = 40
  special = false # used inside DATABASE_URL unencoded
}

# Suffix for the final snapshot: RDS keeps it after the instance is deleted,
# so a deployment recreated under the same name needs a new name for its own.
resource "random_id" "final_snapshot" {
  byte_length = 4
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
  apply_immediately          = false
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
}
