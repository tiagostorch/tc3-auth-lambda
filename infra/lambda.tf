# ─── Segredo do JWT ─────────────────────────────────────────────────────────
# Emitido aqui e validado pela API no EKS — por isso vai para o SSM, de onde os
# dois lados leem o mesmo valor.

resource "random_password" "jwt_secret" {
  length  = 64
  special = false
}

resource "aws_ssm_parameter" "jwt_secret" {
  name        = "${local.ssm_prefix}/JWT_SECRET"
  description = "Segredo compartilhado entre a Lambda emissora e a API validadora"
  type        = "SecureString"
  value       = random_password.jwt_secret.result
}

# ─── Rede ───────────────────────────────────────────────────────────────────

resource "aws_security_group" "lambda" {
  name        = "${local.identificador}-lambda"
  description = "Lambda de autenticacao"
  vpc_id      = local.vpc_id
}

resource "aws_vpc_security_group_egress_rule" "lambda_saida" {
  security_group_id = aws_security_group.lambda.id
  description       = "Saida liberada (Postgres e endpoints AWS)"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

# Autoriza a Lambda no security group do RDS, que é gerenciado em tc3-infra-db.
resource "aws_vpc_security_group_ingress_rule" "db_aceita_lambda" {
  security_group_id            = local.db_security_group
  description                  = "Postgres a partir da Lambda de autenticacao"
  referenced_security_group_id = aws_security_group.lambda.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

# ─── Permissões ─────────────────────────────────────────────────────────────

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  name               = local.identificador
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "lambda_vpc" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

data "aws_iam_policy_document" "lambda_ssm" {
  statement {
    effect    = "Allow"
    actions   = ["ssm:GetParameter", "ssm:GetParameters"]
    resources = ["arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.atual.account_id}:parameter${local.ssm_prefix}/*"]
  }
}

resource "aws_iam_role_policy" "lambda_ssm" {
  name   = "${local.identificador}-ssm"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.lambda_ssm.json
}

# ─── Função ─────────────────────────────────────────────────────────────────

resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${local.identificador}"
  retention_in_days = 7
}

resource "aws_lambda_function" "auth" {
  function_name = local.identificador
  role          = aws_iam_role.lambda.arn

  filename         = var.lambda_package_path
  source_code_hash = filebase64sha256(var.lambda_package_path)

  runtime = "nodejs22.x"
  handler = "index.handler"

  memory_size = var.lambda_memory_mb
  timeout     = var.lambda_timeout_seconds

  # Dentro da VPC para alcançar o RDS, que não é público.
  vpc_config {
    subnet_ids         = local.private_subnet_ids
    security_group_ids = [aws_security_group.lambda.id]
  }

  environment {
    variables = {
      DATABASE_URL   = data.aws_ssm_parameter.database_url.value
      JWT_SECRET     = random_password.jwt_secret.result
      JWT_EXPIRES_IN = var.jwt_expires_in
      NODE_OPTIONS   = "--enable-source-maps"
    }
  }

  depends_on = [aws_cloudwatch_log_group.lambda]
}
