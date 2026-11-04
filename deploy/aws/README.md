# deploy/aws

Terraform and scripts that run Retainer on AWS Lambda, API Gateway and RDS.
The guide is [docs/aws.md](../../docs/aws.md).

| File              | What it does                                                         |
| ----------------- | -------------------------------------------------------------------- |
| `state-bucket.sh` | Creates the S3 bucket for Terraform's state, once                    |
| `build.sh`        | Builds the Lambda package (`.build/retainer.zip`)                    |
| `*.tf`            | The infrastructure                                                   |
| `deploy.sh`       | Ships a package: stop, migrate, update, start                        |
| `ops.sh`          | Runs the operator CLI (workspaces and keys) through the ops function |
| `*.example`       | Templates for the gitignored `terraform.tfvars` and `backend.hcl`    |
