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

# A política gerenciada `AWSLambdaVPCAccessExecutionRole` faria o serviço, e é
# o caminho padrão — mas ela embute `logs:CreateLogGroup` e `logs:PutLogEvents`,
# e é essa permissão que faz a Lambda criar e alimentar o log group do
# CloudWatch sozinha. Com a telemetria indo direto para o New Relic pela
# extension, o log group seria uma segunda cópia de tudo, cobrada por GB.
#
# Então a permissão de rede vem por política própria, sem `logs`. O efeito
# colateral é real e vale saber: sem permissão de escrita, o CloudWatch fica
# vazio de verdade, inclusive quando a extension é quem falha. Para depurar
# esse caso, `cloudwatch_logs_enabled = true` devolve o comportamento padrão.
data "aws_iam_policy_document" "lambda_rede" {
  statement {
    effect = "Allow"

    actions = [
      "ec2:CreateNetworkInterface",
      "ec2:DescribeNetworkInterfaces",
      "ec2:DeleteNetworkInterface",
      "ec2:AssignPrivateIpAddresses",
      "ec2:UnassignPrivateIpAddresses",
    ]

    # A API do EC2 não aceita recurso específico para estas ações: a ENI ainda
    # não existe quando a permissão é avaliada.
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "lambda_rede" {
  name   = "${local.identificador}-rede"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.lambda_rede.json
}

data "aws_iam_policy_document" "lambda_logs" {
  count = var.cloudwatch_logs_enabled ? 1 : 0

  statement {
    effect = "Allow"

    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]

    resources = ["arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.atual.account_id}:log-group:/aws/lambda/${local.identificador}:*"]
  }
}

resource "aws_iam_role_policy" "lambda_logs" {
  count = var.cloudwatch_logs_enabled ? 1 : 0

  name   = "${local.identificador}-logs"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.lambda_logs[0].json
}

# Também é por esta permissão que a extension do New Relic lê a license key em
# runtime (NEW_RELIC_LICENSE_KEY_SSM_PARAMETER_NAME). O parâmetro é
# SecureString com a chave gerenciada `aws/ssm`, cuja política já autoriza o
# decrypt via SSM a qualquer principal da conta — não há kms:Decrypt a somar.
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

# Só existe quando o modo de depuração está ligado. No caminho normal, o log da
# função sai pela extension com `NEW_RELIC_EXTENSION_SEND_FUNCTION_LOGS`, sem
# passar por aqui.
resource "aws_cloudwatch_log_group" "lambda" {
  count = var.cloudwatch_logs_enabled ? 1 : 0

  name              = "/aws/lambda/${local.identificador}"
  retention_in_days = 7
}

# ─── Telemetria ─────────────────────────────────────────────────────────────
# A layer do New Relic traz duas coisas no mesmo pacote: o agente Node, que
# instrumenta a função, e a extension, que é um processo do runtime rodando ao
# lado do handler.
#
# A diferença entre elas é o que torna este desenho possível. O agente sozinho
# escreve telemetria no stdout, e alguém precisa recolher — na receita oficial,
# um log group do CloudWatch com uma subscription para uma segunda Lambda de
# ingestão. A extension recolhe no próprio processo e faz POST direto na API do
# New Relic ao fim de cada invocação. Ninguém no meio, nada cobrado por GB.
#
#   handler ──▶ agente ──▶ extension ──HTTPS──▶ New Relic
#
# O caminho de saída é a NAT da VPC: a função roda em subnet privada, e sem rota
# para a internet a extension acumula telemetria até o timeout e descarta.

locals {
  # Endpoints de ingestão por datacenter da conta. Sem isto, uma conta EU envia
  # para o coletor US e recebe 403 — silenciosamente, do lado de dentro da
  # função, onde ninguém está olhando.
  newrelic_endpoints = {
    US = {
      telemetria = "https://cloud-collector.newrelic.com/aws/lambda/v1"
      logs       = "https://log-api.newrelic.com/log/v1"
    }
    EU = {
      telemetria = "https://cloud-collector.eu01.nr-data.net/aws/lambda/v1"
      logs       = "https://log-api.eu.newrelic.com/log/v1"
    }
  }

  newrelic_env = var.newrelic_enabled ? {
    # A layer substitui o handler: quem o Lambda chama é o wrapper, que sobe o
    # agente e depois invoca o handler real apontado aqui.
    NEW_RELIC_LAMBDA_HANDLER = "index.handler"

    NEW_RELIC_ACCOUNT_ID = var.newrelic_account_id
    NEW_RELIC_APP_NAME   = local.identificador

    # Chave de confiança do tracestate W3C: com ela o agente aceita a entrada
    # `<conta>@nr` do `tracestate` vinda de outro serviço da mesma conta (a API
    # no cluster) e mantém a amostragem e a prioridade do trace de origem.
    NEW_RELIC_TRUSTED_ACCOUNT_KEY = var.newrelic_account_id

    # A license key NÃO fica na configuração da função: a variável carrega só o
    # nome do parâmetro no SSM, e a extension o lê na inicialização (permissão
    # em `lambda_ssm`). Antes a chave ia em texto puro para cá — visível no
    # console da Lambda para qualquer um com lambda:GetFunctionConfiguration e
    # gravada no state do Terraform.
    NEW_RELIC_LICENSE_KEY_SSM_PARAMETER_NAME = one(data.aws_ssm_parameter.newrelic_license_key[*].name)

    # Liga a extension. Desligada, o agente volta a depender do CloudWatch.
    NEW_RELIC_LAMBDA_EXTENSION_ENABLED = "true"

    # O item central desta entrega: a extension lê o stdout da função e faz o
    # push do log direto para a API, sem log group nem subscription filter.
    NEW_RELIC_EXTENSION_SEND_FUNCTION_LOGS = "true"

    # O log da própria extension não: é diagnóstico do agente, não da aplicação,
    # e em free tier todo GB conta.
    NEW_RELIC_EXTENSION_SEND_EXTENSION_LOGS = "false"

    NEW_RELIC_TELEMETRY_ENDPOINT = local.newrelic_endpoints[var.newrelic_region].telemetria
    NEW_RELIC_LOG_ENDPOINT       = local.newrelic_endpoints[var.newrelic_region].logs

    # Liga o trace da autenticação ao trace da API no cluster: as duas pontas
    # aparecem no mesmo trace distribuído.
    #
    # W3C Trace Context: o agente lê `traceparent`/`tracestate` dos cabeçalhos
    # do evento do API Gateway antes do handler rodar, e a invocação passa a
    # ser um span do trace do cliente. Na saída, só os cabeçalhos W3C — o
    # proprietário `newrelic` fica de fora (a entrada continua aceitando os
    # três). Mesmo ajuste do ConfigMap da API.
    NEW_RELIC_DISTRIBUTED_TRACING_ENABLED                 = "true"
    NEW_RELIC_DISTRIBUTED_TRACING_EXCLUDE_NEWRELIC_HEADER = "true"

    # Toda a configuração está aqui; sem isto o agente procura um newrelic.js
    # que o bundle do esbuild não gera.
    NEW_RELIC_NO_CONFIG_FILE = "true"

    # Quanto a extension espera pelo POST antes de desistir e devolver a
    # invocação. Acima disso, telemetria passa a atrasar resposta ao cliente.
    NEW_RELIC_DATA_COLLECTION_TIMEOUT = "5s"

    NEW_RELIC_EXTENSION_LOG_LEVEL = "INFO"
  } : {}
}

resource "aws_lambda_function" "auth" {
  function_name = local.identificador
  role          = aws_iam_role.lambda.arn

  filename         = var.lambda_package_path
  source_code_hash = filebase64sha256(var.lambda_package_path)

  runtime = "nodejs22.x"
  handler = var.newrelic_enabled ? "newrelic-lambda-wrapper.handler" : "index.handler"

  # A layer do New Relic é publicada em duas variantes, uma por arquitetura, e
  # cada uma declara só a sua em `CompatibleArchitectures`. Usar a variante
  # errada faz o apply falhar no meio (InvalidParameterValueException). A
  # precondition mais abaixo confere as duas coisas juntas.
  architectures = [var.lambda_architecture]

  layers = var.newrelic_enabled ? [var.newrelic_layer_arn] : []

  memory_size = var.lambda_memory_mb
  timeout     = var.lambda_timeout_seconds

  # Dentro da VPC para alcançar o RDS, que não é público.
  vpc_config {
    subnet_ids         = local.private_subnet_ids
    security_group_ids = [aws_security_group.lambda.id]
  }

  environment {
    variables = merge(
      {
        DATABASE_URL   = data.aws_ssm_parameter.database_url.value
        JWT_SECRET     = random_password.jwt_secret.result
        JWT_EXPIRES_IN = var.jwt_expires_in
        NODE_OPTIONS   = "--enable-source-maps"

        # Tags padrão do projeto (environment/project). O handler as escreve em
        # todo log e as prende à invocação (AwsLambdaInvocation) — mesmas tags
        # e mesma variável da API. Fora de `newrelic_env` de propósito: com a
        # instrumentação desligada, o log continua saindo com as tags.
        NEW_RELIC_LABELS = local.newrelic_labels
      },
      local.newrelic_env,
    )
  }

  lifecycle {
    # Sem account ID o agente não consegue montar o `tracestate`, e a
    # correlação W3C com a API se perde sem erro visível.
    precondition {
      condition     = !var.newrelic_enabled || var.newrelic_account_id != ""
      error_message = "newrelic_account_id está vazio com newrelic_enabled = true (TF_VAR_newrelic_account_id — secret NEW_RELIC_ACCOUNT_ID no CI, .env localmente)."
    }

    # A variante ARM64 da layer traz "ARM64" no nome; a x86 não. Conferir isso
    # no plan evita descobrir a incompatibilidade só quando a AWS recusa o
    # apply — ou, pior, com a função subindo e o wrapper falhando na invocação.
    precondition {
      condition = (
        !var.newrelic_enabled ||
        var.newrelic_layer_arn == "" ||
        (strcontains(upper(var.newrelic_layer_arn), "ARM64") == (var.lambda_architecture == "arm64"))
      )
      error_message = <<-EOT
        newrelic_layer_arn e lambda_architecture não combinam.

        Layer informada:      ${var.newrelic_layer_arn}
        Arquitetura da função: ${var.lambda_architecture}

        A layer NewRelicNodeJS22XARM64 só funciona em arm64; a NewRelicNodeJS22X,
        só em x86_64. Escolha um dos dois caminhos:

          1. lambda_architecture = "arm64" (TF_VAR_lambda_architecture=arm64)
             Mantém a layer ARM64 e ainda sai ~20% mais barato. O pacote é
             JavaScript puro (esbuild + pg + jsonwebtoken), então roda igual.

          2. Trocar a ARN pela variante x86_64 (NewRelicNodeJS22X, sem ARM64),
             na versão correspondente — lista em
             https://layers.newrelic-external.com
      EOT
    }

    precondition {
      condition     = !var.newrelic_enabled || var.newrelic_layer_arn != ""
      error_message = <<-EOT
        newrelic_layer_arn está vazio com newrelic_enabled = true.

        A ARN muda por região e por versão do agente. A lista publicada está em
        https://layers.newrelic-external.com — procurar NewRelicNodeJS22X na
        região do projeto e copiar a ARN completa, com o número de versão no fim.
      EOT
    }
  }
}
