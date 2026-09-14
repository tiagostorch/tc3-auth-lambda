output "api_endpoint" {
  description = "URL base do API Gateway."
  value       = aws_apigatewayv2_api.http.api_endpoint
}

output "auth_url" {
  description = "Rota de autenticação por CPF."
  value       = "${aws_apigatewayv2_api.http.api_endpoint}/auth"
}

output "mail_url" {
  description = "Rota interna para emissão de e-mails. Exige x-mail-api-token."
  value       = "${aws_apigatewayv2_api.http.api_endpoint}/mail"
}

output "ssm_mail_api_token_name" {
  description = "Parâmetro que deve ser sincronizado com MAIL_LAMBDA_TOKEN no Kubernetes."
  value       = aws_ssm_parameter.mail_api_token.name
}

output "ssm_mail_smtp_parameter_names" {
  description = "Parâmetros SecureString que precisam existir antes do deploy da Lambda de e-mail."
  value = {
    MAIL_HOST = "${local.ssm_prefix}/MAIL_HOST"
    MAIL_PORT = "${local.ssm_prefix}/MAIL_PORT"
    MAIL_USER = "${local.ssm_prefix}/MAIL_USER"
    MAIL_PASS = "${local.ssm_prefix}/MAIL_PASS"
  }
}

output "lambda_function_name" {
  value = aws_lambda_function.auth.function_name
}

output "ssm_jwt_secret_name" {
  description = "Parâmetro que a aplicação no EKS lê para validar os tokens."
  value       = aws_ssm_parameter.jwt_secret.name
}
