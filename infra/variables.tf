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

variable "auth_lambda_package_path" {
  description = "Artefato da Lambda de autenticação gerado por `npm run package`."
  type        = string
  default     = "../auth-lambda.zip"
}

variable "mail_lambda_package_path" {
  description = "Artefato da Lambda de e-mail gerado por `npm run package`."
  type        = string
  default     = "../mail-lambda.zip"
}

variable "jwt_expires_in" {
  type    = string
  default = "1h"
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
