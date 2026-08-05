output "api_endpoint" {
  description = "URL base do API Gateway."
  value       = aws_apigatewayv2_api.http.api_endpoint
}

output "auth_url" {
  description = "Rota de autenticação por CPF."
  value       = "${aws_apigatewayv2_api.http.api_endpoint}/auth"
}

output "lambda_function_name" {
  value = aws_lambda_function.auth.function_name
}

output "ssm_jwt_secret_name" {
  description = "Parâmetro que a aplicação no EKS lê para validar os tokens."
  value       = aws_ssm_parameter.jwt_secret.name
}
