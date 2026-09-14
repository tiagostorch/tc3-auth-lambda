data "terraform_remote_state" "k8s" {
  backend = "s3"

  config = {
    bucket = var.state_bucket
    key    = "infra-k8s/terraform.tfstate"
    region = var.aws_region
  }
}

data "terraform_remote_state" "db" {
  backend = "s3"

  config = {
    bucket = var.state_bucket
    key    = "infra-db/terraform.tfstate"
    region = var.aws_region
  }
}

data "aws_caller_identity" "atual" {}

# A senha do banco vive apenas no SSM; aqui só a referenciamos.
data "aws_ssm_parameter" "database_url" {
  name = data.terraform_remote_state.db.outputs.ssm_database_url_name
}

locals {
  identificador      = "${var.project_name}-${var.environment}-auth"
  mail_identificador = "${var.project_name}-${var.environment}-mail"
  ssm_prefix         = data.terraform_remote_state.db.outputs.ssm_prefix

  vpc_id             = data.terraform_remote_state.k8s.outputs.vpc_id
  private_subnet_ids = data.terraform_remote_state.k8s.outputs.private_subnet_ids
  db_security_group  = data.terraform_remote_state.db.outputs.db_security_group_id
}
