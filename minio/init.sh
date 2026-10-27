#!/bin/sh
set -eu

mc alias set local "$MINIO_ENDPOINT" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" > /dev/null

bucket_policy() {
  printf '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:GetBucketLocation","s3:ListBucket"],"Resource":["arn:aws:s3:::%s"]},{"Effect":"Allow","Action":["s3:GetObject","s3:PutObject","s3:DeleteObject"],"Resource":["arn:aws:s3:::%s/*"]}]}' "$1" "$1"
}

service_user() {
  name="$1" bucket="$2" access_key="$3" secret_key="$4"
  mc mb --ignore-existing "local/$bucket"
  bucket_policy "$bucket" > "/tmp/$name.json"
  mc admin policy create local "$name-bucket" "/tmp/$name.json"
  mc admin user add local "$access_key" "$secret_key"
  case "$(mc admin user info local "$access_key")" in
    *"$name-bucket"*) ;;
    *) mc admin policy attach local "$name-bucket" --user "$access_key" ;;
  esac
  echo "MinIO: usuario $access_key con acceso solo a $bucket"
}

service_user catalog "$MINIO_BUCKET_POSTERS" "$CATALOG_MINIO_ACCESS_KEY" "$CATALOG_MINIO_SECRET_KEY"
service_user ticket "$MINIO_BUCKET_QR" "$TICKET_MINIO_ACCESS_KEY" "$TICKET_MINIO_SECRET_KEY"
