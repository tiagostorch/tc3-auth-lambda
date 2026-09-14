variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "project_name" {
  type    = string
  default = "tc3-oficina"
}

variable "environment" {
  type    = string
  default = "homolog"
}

variable "state_bucket" {
  description = "Bucket do state remoto — o mesmo criado no bootstrap de tc3-infra-k8s."
  type        = string
}

variable "lambda_package_path" {
  description = "Artefato gerado por `npm run package`."
  type        = string
  default     = "../lambda.zip"
}

variable "jwt_expires_in" {
  type    = string
  default = "1h"
}

variable "lambda_architecture" {
  description = <<-EOT
    Arquitetura da função. Precisa casar com a variante da layer do New Relic
    (NewRelicNodeJS22X para x86_64, NewRelicNodeJS22XARM64 para arm64) — a
    precondition em lambda.tf confere as duas juntas.

    O pacote é JavaScript puro (esbuild, pg e jsonwebtoken não têm binário
    nativo), então as duas arquiteturas servem; arm64 custa ~20% menos.
  EOT
  type        = string
  default     = "x86_64"

  validation {
    condition     = contains(["x86_64", "arm64"], var.lambda_architecture)
    error_message = "lambda_architecture deve ser x86_64 ou arm64."
  }
}

variable "lambda_memory_mb" {
  type    = number
  default = 512
}

variable "lambda_timeout_seconds" {
  type    = number
  default = 15
}

variable "alb_listener_arn" {
  description = <<-EOT
    Listener do ALB criado pelo Ingress da aplicação no EKS. Enquanto vazio, o
    Gateway expõe apenas a rota de autenticação; preenchido, passa a rotear
    também as rotas protegidas via VPC Link.
  EOT
  type        = string
  default     = ""
}

# ─── Observabilidade ────────────────────────────────────────────────────────

variable "newrelic_enabled" {
  description = <<-EOT
    Instrumenta a função com a layer do New Relic. Desligado, a Lambda sobe
    exatamente como antes — útil para isolar a telemetria quando se está
    depurando a própria função.
  EOT
  type        = bool
  default     = true
}

variable "newrelic_layer_arn" {
  description = <<-EOT
    ARN completa da layer `NewRelicNodeJS22X`, com o número de versão no fim.

    Muda por região e a cada release do agente, e não dá para descobrir por data
    source: a layer é pública mas mora na conta 451483290750, e a API só lista
    versões de layer da própria conta. A lista publicada está em
    https://layers.newrelic-external.com.

    Exemplo (us-east-1):
      arn:aws:lambda:us-east-1:451483290750:layer:NewRelicNodeJS22X:1
  EOT
  type        = string
  default     = ""
}

variable "newrelic_account_id" {
  description = "Account ID numérico da conta New Relic. Mesmo valor usado em tc3-infra-k8s."
  type        = string
  default     = ""

  # Vazio é aceito aqui (telemetria desligada); a precondition da função exige
  # o valor quando newrelic_enabled = true.
  validation {
    condition     = can(regex("^[0-9]*$", var.newrelic_account_id))
    error_message = "newrelic_account_id deve ser o Account ID numérico (ex.: 1234567). Um placeholder precisa ser substituído pelo valor real."
  }
}

variable "newrelic_tags" {
  description = <<-EOT
    Tags padrão do projeto em toda telemetria da função (logs e invocações).
    Os mesmos valores de `newrelic_tags` em tc3-infra-k8s e tc3-infra-db e de
    NEW_RELIC_LABELS no ConfigMap da aplicação — é por elas que os alertas e
    dashboards filtram. Separadas de `environment`, que compõe nomes de recurso.
  EOT
  type        = map(string)
  default = {
    environment = "production"
    project     = "tech-challenge-fiap"
  }

  validation {
    condition     = alltrue([for chave in ["environment", "project"] : contains(keys(var.newrelic_tags), chave)])
    error_message = "newrelic_tags precisa conter as chaves 'environment' e 'project'."
  }

  validation {
    condition     = alltrue([for chave, valor in var.newrelic_tags : can(regex("^[A-Za-z0-9_.-]+$", chave)) && can(regex("^[A-Za-z0-9_.-]+$", valor))])
    error_message = "Chaves e valores de newrelic_tags aceitam apenas letras, dígitos, '_', '.' e '-'."
  }
}

variable "newrelic_region" {
  description = "Datacenter da conta: US ou EU. Define o endpoint para onde a extension faz o POST."
  type        = string
  default     = "US"

  validation {
    condition     = contains(["US", "EU"], var.newrelic_region)
    error_message = "newrelic_region deve ser US ou EU."
  }
}

variable "cloudwatch_logs_enabled" {
  description = <<-EOT
    Devolve à função a permissão de escrever no CloudWatch Logs e recria o log
    group.

    Desligado por padrão: com a extension fazendo o envio direto, o log group
    seria uma segunda cópia integral do log, cobrada por GB ingerido e por GB
    armazenado. Ligar quando a suspeita for da própria extension — é o único
    cenário em que o log do CloudWatch mostra algo que o New Relic não mostra.
  EOT
  type        = bool
  default     = false
}
