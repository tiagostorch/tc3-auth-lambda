# tc3-auth-lambda

Function serverless de autenticação por CPF do Tech Challenge Fase 3 (FIAP SOAT) — sistema de gestão de oficina mecânica.

Recebe um CPF pelo API Gateway, confirma que o cliente existe e está ativo no banco e devolve um JWT aceito pela API da oficina. Este repositório contém **a função e o API Gateway** — a porta de entrada de toda a aplicação.

## O que este repositório cria

| Recurso | Detalhe |
|---|---|
| `aws_lambda_function` | Node.js 22, dentro da VPC para alcançar o RDS |
| API Gateway HTTP API | Rota `POST /auth` + rotas protegidas via VPC Link |
| Segredo do JWT | Gerado pelo Terraform e publicado no SSM |
| Security groups | Libera a Lambda no Postgres |
| Log groups | Logs JSON com `requestId` para correlação |

## Tecnologias

TypeScript · Node.js 22 · `pg` · `jsonwebtoken` · esbuild · Terraform ≥ 1.10 · AWS Lambda · API Gateway · GitHub Actions

## Dependências

Depende de `tc3-infra-k8s` (rede) e `tc3-infra-db` (banco e `DATABASE_URL`), lidos pelo state remoto. Aplique os dois antes.

**Pré-requisito de schema:** a coluna `status` em `Cliente` precisa existir — é o ajuste de modelagem previsto para esta fase. Sem ela a consulta falha.

## Fluxo

```
   cliente ──POST /auth {cpf}──▶ API Gateway ──▶ Lambda
                                                   │
                                       valida dígitos verificadores
                                                   │
                                                   ▼
                                          RDS: existe? ativo?
                                                   │
                                     assina JWT (segredo do SSM)
                                                   │
   cliente ◀────── { token, cliente } ─────────────┘

   cliente ──Bearer token──▶ API Gateway ──VPC Link──▶ ALB ──▶ API no EKS
```

A API no EKS valida o token com o mesmo segredo, sem chamar esta função.

## Execução local

```bash
npm ci
npm test          # validação de CPF
npm run package   # gera lambda.zip
```

## Deploy

```bash
npm run package

cd infra
cp terraform.tfvars.example terraform.tfvars   # editar
terraform init -backend-config="bucket=SEU_BUCKET"
terraform apply
```

O endereço sai no output `auth_url`.

## Uso da API

```bash
curl -X POST "$AUTH_URL" \
  -H 'content-type: application/json' \
  -d '{"cpf":"529.982.247-25"}'
```

```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "expiresIn": "1h",
  "cliente": { "id": "uuid", "nome": "Fulano de Tal" }
}
```

| Status | Situação |
|---|---|
| 200 | Cliente válido e ativo — token emitido |
| 400 | CPF ausente, malformado ou com dígito verificador inválido |
| 404 | CPF válido, mas sem cliente correspondente |
| 403 | Cliente encontrado, porém inativo |
| 500 | Falha ao consultar o banco |

A documentação Swagger das rotas protegidas fica no repositório da aplicação, em `/api`.

## CI/CD

`.github/workflows/deploy.yml`

- **Pull request** → lint, testes, empacotamento e `terraform plan`
- **Push em `develop`** → deploy em homologação
- **Push em `main`** → deploy em produção

Secrets necessários: `AWS_ROLE_ARN` e `TF_STATE_BUCKET` (vindos do bootstrap em `tc3-infra-k8s`).

## Decisões registradas

- **`pg` em vez do Prisma na Lambda** — o engine do Prisma pesa dezenas de MB e encarece o cold start; a função faz uma única consulta, e o driver puro basta.
- **Função dentro da VPC** — obrigatório para alcançar um RDS não público; o custo é um cold start maior, aceitável para o volume desta operação.
- **Segredo compartilhado (HS256)** — mais simples que JWKS para o escopo da fase; a API valida localmente, sem round-trip.

Estas decisões viram ADRs na documentação oficial da entrega.
