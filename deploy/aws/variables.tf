variable "region" {
  description = "AWS region to deploy into, e.g. eu-central-1."
  type        = string
}

variable "name" {
  description = "Prefix for every resource name. Function names start with it, and the GitHub deploy role may only touch functions named <name>-*."
  type        = string
  default     = "retainer"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}$", var.name))
    error_message = "Use 2-31 lowercase letters, digits or dashes, starting with a letter."
  }
}

variable "tags" {
  description = "Extra tags for every resource."
  type        = map(string)
  default     = {}
}

variable "package_path" {
  description = "Lambda package built by build.sh. Used only when the functions are created; deploy.sh ships later versions."
  type        = string
  default     = ".build/retainer.zip"
}

# ─── Domain ──────────────────────────────────────────────────────────────────

variable "domain_name" {
  description = "Custom domain, e.g. retainer.example.com. Leave null to use the API Gateway URL."
  type        = string
  default     = null
}

variable "domain_certificate_validated" {
  description = "Set to true once the certificate's DNS validation record (output dns_records) exists and ACM shows the certificate as issued. Attaches the domain and makes it the public origin."
  type        = bool
  default     = false
}

# ─── Database ────────────────────────────────────────────────────────────────

variable "db_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.micro"
}

variable "db_engine_version" {
  description = "PostgreSQL major version."
  type        = string
  default     = "17"
}

variable "db_allocated_storage_gb" {
  description = "Initial storage in GB; storage autoscaling may grow it to db_max_allocated_storage_gb."
  type        = number
  default     = 20
}

variable "db_max_allocated_storage_gb" {
  description = "Upper bound for storage autoscaling, in GB."
  type        = number
  default     = 100
}

variable "db_backup_retention_days" {
  description = "Days of automated backups (point-in-time recovery window)."
  type        = number
  default     = 14
}

variable "db_multi_az" {
  description = "Run a standby in a second availability zone. Doubles the database cost."
  type        = bool
  default     = false
}

variable "db_deletion_protection" {
  description = "Refuse to delete the database. Set to false and apply before terraform destroy."
  type        = bool
  default     = true
}

# ─── Functions and API ───────────────────────────────────────────────────────

variable "api_reserved_concurrency" {
  description = "Most API function instances at once. Each holds up to api_db_pool_max database connections, so keep the product under the database's connection limit."
  type        = number
  default     = 10
}

variable "api_db_pool_max" {
  description = "Database connections per API function instance."
  type        = number
  default     = 2
}

variable "api_memory_mb" {
  description = "Memory for the API function; CPU scales with it."
  type        = number
  default     = 1024
}

variable "api_throttle_rate" {
  description = "Steady-state requests per second API Gateway accepts."
  type        = number
  default     = 25
}

variable "api_throttle_burst" {
  description = "Burst of requests API Gateway accepts."
  type        = number
  default     = 50
}

variable "consolidate_interval_minutes" {
  description = "How often each workspace is consolidated (RETAINER_CONSOLIDATE_INTERVAL_MINUTES)."
  type        = number
  default     = 60
}

variable "consolidate_schedule" {
  description = "How often the consolidate function looks for due workspaces."
  type        = string
  default     = "rate(15 minutes)"
}

variable "log_level" {
  description = "Server log level: debug, info, warn or error."
  type        = string
  default     = "info"
}

variable "log_retention_days" {
  description = "Days to keep function and access logs."
  type        = number
  default     = 30
}

# ─── Operations ──────────────────────────────────────────────────────────────

variable "alarm_email" {
  description = "Email for CloudWatch alarms. AWS sends a confirmation link first. Null creates the alarms and topic without a subscriber."
  type        = string
  default     = null
}

variable "github_repository" {
  description = "owner/repo whose deploy workflow may ship code (assume the deploy role). Null creates no role."
  type        = string
  default     = null
}

variable "github_environment" {
  description = "GitHub Environment the deploy workflow runs in. Only jobs in it can assume the role."
  type        = string
  default     = "production"
}
