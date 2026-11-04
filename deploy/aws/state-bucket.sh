#!/usr/bin/env bash
# Creates the S3 bucket for Terraform state, once per AWS account:
# versioned, encrypted, private. Safe to run again. Prints the backend.hcl
# to use with it. Deployments in other regions share the bucket; the state
# key includes the region, so each keeps its own state.
#   AWS_REGION=eu-central-1 deploy/aws/state-bucket.sh [name]
set -euo pipefail

name="${1:-retainer}"
region="${AWS_REGION:?set AWS_REGION}"
account="$(aws sts get-caller-identity --query Account --output text)"
bucket="$name-terraform-state-$account"

if aws s3api head-bucket --bucket "$bucket" >/dev/null 2>&1; then
  echo "Bucket $bucket exists." >&2
else
  if [ "$region" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$bucket" --region "$region" >/dev/null
  else
    aws s3api create-bucket --bucket "$bucket" --region "$region" \
      --create-bucket-configuration "LocationConstraint=$region" >/dev/null
  fi
  echo "Created bucket $bucket." >&2
fi

# The backend needs the bucket's own region, which differs from AWS_REGION
# when the bucket was created for a deployment elsewhere.
bucket_region="$(aws s3api get-bucket-location --bucket "$bucket" \
  --query LocationConstraint --output text)"
case "$bucket_region" in None | null | "") bucket_region=us-east-1 ;; esac

aws s3api put-public-access-block --bucket "$bucket" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-versioning --bucket "$bucket" --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket "$bucket" --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}'

cat <<HCL
bucket       = "$bucket"
key          = "$name/$region/terraform.tfstate"
region       = "$bucket_region"
use_lockfile = true
HCL
