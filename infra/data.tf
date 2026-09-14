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

# Publicada por tc3-infra-k8s, que é quem recebe a chave como secret de CI.
# `count` para o repositório continuar aplicável com a telemetria desligada,
# antes de a conta do New Relic existir.
#
# `with_decryption = false`: aqui só se confirma que o parâmetro EXISTE (o plan
# falha cedo se tc3-infra-k8s ainda não o publicou) e se obtém o nome. O valor
# em claro nunca passa pelo Terraform — o state guarda só o texto cifrado — e a
# função recebe apenas o NOME do parâmetro; quem lê a chave, em runtime, é a
# extension do New Relic.
data "aws_ssm_parameter" "newrelic_license_key" {
  count = var.newrelic_enabled ? 1 : 0

  name            = "${local.ssm_prefix}/NEW_RELIC_LICENSE_KEY"
  with_decryption = false
}

locals {
  identificador      = "${var.project_name}-${var.environment}-auth"
  mail_identificador = "${var.project_name}-${var.environment}-mail"
  ssm_prefix         = data.terraform_remote_state.db.outputs.ssm_prefix

  # Tags padrão no formato de NEW_RELIC_LABELS, idêntico ao da API no cluster.
  newrelic_labels = join(";", [for chave, valor in var.newrelic_tags : "${chave}:${valor}"])

  vpc_id             = data.terraform_remote_state.k8s.outputs.vpc_id
  private_subnet_ids = data.terraform_remote_state.k8s.outputs.private_subnet_ids
  db_security_group  = data.terraform_remote_state.db.outputs.db_security_group_id
}
