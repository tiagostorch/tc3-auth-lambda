/**
 * Autenticação por CPF do Tech Challenge Fase 3.
 *
 * Recebe um CPF, confirma que o cliente existe e está ativo no banco e devolve
 * um JWT aceito pela API da oficina — que valida o token com o mesmo segredo,
 * sem precisar consultar este serviço.
 */

import { Pool } from 'pg';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { cpfValido, formatarCpf, normalizarCpf } from './cpf';

interface EventoHttp {
  body?: string | null;
  isBase64Encoded?: boolean;
}

interface Resposta {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

interface ClienteRow {
  id: string;
  nome: string;
  status: string | null;
}

// Reaproveitado entre invocações na mesma instância: abrir conexão a cada
// requisição esgota o limite de conexões do RDS sob carga.
let pool: Pool | undefined;

function obterPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 2,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,

      // O RDS recusa conexão sem TLS (rds.force_ssl), e o driver só negocia
      // criptografia se pedirmos. Sem verificar o certificado: a CA do RDS não
      // está no bundle padrão do Node, e o tráfego não sai da VPC.
      ssl: { rejectUnauthorized: false },
    });
  }

  return pool;
}

function responder(statusCode: number, corpo: unknown, correlationId: string): Resposta {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json',
      'x-correlation-id': correlationId,
    },
    body: JSON.stringify(corpo),
  };
}

function log(nivel: 'info' | 'warn' | 'error', mensagem: string, extra: Record<string, unknown> = {}) {
  // JSON estruturado com correlação, como exige a fase.
  console.log(
    JSON.stringify({
      nivel,
      mensagem,
      servico: 'auth-lambda',
      timestamp: new Date().toISOString(),
      ...extra,
    }),
  );
}

export async function handler(evento: EventoHttp, contexto: { awsRequestId: string }): Promise<Resposta> {
  const correlationId = contexto?.awsRequestId ?? 'sem-correlacao';

  let cpfInformado: string;

  try {
    const bruto = evento.isBase64Encoded && evento.body
      ? Buffer.from(evento.body, 'base64').toString('utf8')
      : evento.body;

    cpfInformado = JSON.parse(bruto ?? '{}').cpf ?? '';
  } catch {
    log('warn', 'Corpo da requisicao nao e JSON valido', { correlationId });
    return responder(400, { mensagem: 'Corpo da requisição inválido.' }, correlationId);
  }

  const cpf = normalizarCpf(cpfInformado);

  if (!cpfValido(cpf)) {
    log('warn', 'CPF reprovado na validacao', { correlationId });
    return responder(400, { mensagem: 'CPF inválido.' }, correlationId);
  }

  let cliente: ClienteRow | undefined;

  try {
    const resultado = await obterPool().query<ClienteRow>(
      'SELECT id, nome, status FROM "Cliente" WHERE "cpfCnpj" = $1 LIMIT 1',
      [cpf],
    );

    cliente = resultado.rows[0];
  } catch (erro) {
    log('error', 'Falha ao consultar o cliente', {
      correlationId,
      erro: erro instanceof Error ? erro.message : String(erro),
    });

    return responder(500, { mensagem: 'Erro ao consultar o cliente.' }, correlationId);
  }

  if (!cliente) {
    log('warn', 'Cliente nao encontrado', { correlationId });
    return responder(404, { mensagem: 'Cliente não encontrado.' }, correlationId);
  }

  if (cliente.status && cliente.status !== 'ATIVO') {
    log('warn', 'Cliente inativo', { correlationId, clienteId: cliente.id, status: cliente.status });
    return responder(403, { mensagem: 'Cliente inativo.' }, correlationId);
  }

  // A tipagem de expiresIn aceita apenas literais de duração ("1h", "30m") ou
  // segundos; a variável de ambiente chega como string genérica.
  const expiraEm = (process.env.JWT_EXPIRES_IN ?? '1h') as SignOptions['expiresIn'];

  const token = jwt.sign(
    {
      sub: cliente.id,
      nome: cliente.nome,
      cpf: formatarCpf(cpf),
      tipo: 'cliente',
    },
    process.env.JWT_SECRET as string,
    { expiresIn: expiraEm },
  );

  log('info', 'Token emitido', { correlationId, clienteId: cliente.id });

  return responder(200, {
    token,
    expiresIn: expiraEm,
    cliente: { id: cliente.id, nome: cliente.nome },
  }, correlationId);
}
