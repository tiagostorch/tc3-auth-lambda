resource "aws_apigatewayv2_api" "http" {
  name          = local.identificador
  description   = "Entrada unica da oficina: autenticacao por CPF e rotas protegidas"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = ["*"]
    allow_methods = ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"]
    allow_headers = ["content-type", "authorization"]
  }
}

# ─── Rota de autenticação ───────────────────────────────────────────────────

resource "aws_apigatewayv2_integration" "auth" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.auth.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "post_auth" {
  api_id    = aws_apigatewayv2_api.http.id
  route_key = "POST /auth"
  target    = "integrations/${aws_apigatewayv2_integration.auth.id}"
}

resource "aws_lambda_permission" "api_gateway" {
  statement_id  = "AllowExecutionFromAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.auth.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}

# ─── Rotas protegidas da aplicação ──────────────────────────────────────────
# Ativadas quando o Ingress da aplicação já criou o ALB e o listener foi
# informado em `alb_listener_arn`.

resource "aws_apigatewayv2_vpc_link" "eks" {
  count = var.alb_listener_arn != "" ? 1 : 0

  name               = "${local.identificador}-vpclink"
  subnet_ids         = local.private_subnet_ids
  security_group_ids = [aws_security_group.lambda.id]
}

resource "aws_apigatewayv2_integration" "aplicacao" {
  count = var.alb_listener_arn != "" ? 1 : 0

  api_id             = aws_apigatewayv2_api.http.id
  integration_type   = "HTTP_PROXY"
  integration_method = "ANY"
  integration_uri    = var.alb_listener_arn
  connection_type    = "VPC_LINK"
  connection_id      = aws_apigatewayv2_vpc_link.eks[0].id
}

resource "aws_apigatewayv2_route" "aplicacao" {
  count = var.alb_listener_arn != "" ? 1 : 0

  api_id    = aws_apigatewayv2_api.http.id
  route_key = "ANY /{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.aplicacao[0].id}"
}

# ─── Stage e logs ───────────────────────────────────────────────────────────

resource "aws_cloudwatch_log_group" "api_gateway" {
  name              = "/aws/apigateway/${local.identificador}"
  retention_in_days = 7
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.http.id
  name        = "$default"
  auto_deploy = true

  # Log em JSON, com requestId para correlacionar Gateway, Lambda e aplicação.
  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_gateway.arn

    format = jsonencode({
      requestId       = "$context.requestId"
      ip              = "$context.identity.sourceIp"
      requestTime     = "$context.requestTime"
      httpMethod      = "$context.httpMethod"
      routeKey        = "$context.routeKey"
      status          = "$context.status"
      protocol        = "$context.protocol"
      responseLength  = "$context.responseLength"
      integrationTime = "$context.integrationLatency"
      responseTime    = "$context.responseLatency"
    })
  }

  default_route_settings {
    detailed_metrics_enabled = true
    throttling_burst_limit   = 100
    throttling_rate_limit    = 50
  }
}
