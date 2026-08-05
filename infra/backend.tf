terraform {
  backend "s3" {
    key          = "auth-lambda/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}
