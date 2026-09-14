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
import {
  cabecalho,
  correlationIdSeguro,
  marcarInvocacao,
  metadadosDeTrace,
  tagsDeObservabilidade,
  traceresponseAtual,
} from './observabilidade';

// Evento do API Gateway HTTP API (payload 2.0). O agente da layer lê os
// cabeçalhos W3C (`traceparent`/`tracestate`) deste mesmo objeto por conta
// própria, antes do handler rodar — por isso a invocação entra no trace do
// cliente sem nenhum código aqui. O handler só lê o correlationId.
interface EventoHttp {
  body?: string | null;
  isBase64Encoded?: boolean;
  headers?: Record<string, string | undefined> | null;
}

// Lidas uma vez por instância: NEW_RELIC_LABELS não muda entre invocações.
const TAGS = tagsDeObservabilidade();

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
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-correlation-id': correlationId,
  };

  // W3C Trace Context Level 2: devolve ao cliente o trace em que esta
  // invocação foi registrada. Ausente quando o agente está desligado.
  const traceresponse = traceresponseAtual();
  if (traceresponse) headers.traceresponse = traceresponse;

  return {
    statusCode,
    headers,
    body: JSON.stringify(corpo),
  };
}

function log(level: 'info' | 'warn' | 'error', message: string, extra: Record<string, unknown> = {}) {
  // Uma linha, um JSON. A extension do New Relic lê o stdout e faz o POST direto
  // na API de logs, sem CloudWatch no caminho — e ela quebra por linha, então
  // JSON identado viraria um registro por linha, todos inválidos.
  //
  // O campo do texto se chama `message` porque é o nome que o New Relic usa
  // como corpo do log; com outro nome, a UI mostra o JSON cru na lista.
  console.log(
    JSON.stringify({
      // `level` e `message` com estes nomes de propósito: são os campos que o
      // New Relic reconhece sem regra de parsing — severidade e corpo do log.
      // A API no cluster emite o mesmo par pelo pino, então uma consulta única
      // atravessa os dois serviços.
      level,
      message,
      servico: 'auth-lambda',
      // Tags padrão do projeto (environment/project), as mesmas da API.
      ...TAGS,
      // Epoch em ms, como a API: é o formato que o New Relic usa como horário
      // do registro. String ISO viraria um atributo qualquer.
      timestamp: Date.now(),
      ...metadadosDeTrace(),
      ...extra,
    }),
  );
}

export async function handler(evento: EventoHttp, contexto: { awsRequestId: string }): Promise<Resposta> {
  // Reaproveita o id que o cliente já está usando, como a API do cluster faz
  // (`x-correlation-id` no pino-http): um mesmo id atravessa login e chamadas
  // seguintes. Sem ele, o id da própria invocação.
  const correlationId =
    correlationIdSeguro(cabecalho(evento?.headers, 'x-correlation-id')) ??
    contexto?.awsRequestId ??
    'sem-correlacao';

  marcarInvocacao({ ...TAGS, correlationId });

  let cpfInformado: string;

  try {
    const bruto = evento.isBase64Encoded && evento.body
      ? Buffer.from(evento.body, 'base64').toString('utf8')
      : evento.body;

    cpfInformado = JSON.parse(bruto ?? '{}').cpf ?? '';
  } catch {
    log('warn', 'Corpo da requisicao nao e JSON valido', {
      evento: 'auth.requisicao_invalida',
      correlationId,
    });
    return responder(400, { mensagem: 'Corpo da requisição inválido.' }, correlationId);
  }

  const cpf = normalizarCpf(cpfInformado);

  if (!cpfValido(cpf)) {
    log('warn', 'CPF reprovado na validacao', {
      evento: 'auth.cpf_invalido',
      correlationId,
    });
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
      evento: 'integracao.banco.falha',
      correlationId,
      erro: erro instanceof Error ? erro.message : String(erro),
    });

    return responder(500, { mensagem: 'Erro ao consultar o cliente.' }, correlationId);
  }

  if (!cliente) {
    log('warn', 'Cliente nao encontrado', {
      evento: 'auth.cliente_nao_encontrado',
      correlationId,
    });
    return responder(404, { mensagem: 'Cliente não encontrado.' }, correlationId);
  }

  if (cliente.status && cliente.status !== 'ATIVO') {
    log('warn', 'Cliente inativo', {
      evento: 'auth.cliente_inativo',
      correlationId,
      clienteId: cliente.id,
      status: cliente.status,
    });
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

  log('info', 'Token emitido', {
    evento: 'auth.token_emitido',
    correlationId,
    clienteId: cliente.id,
  });

  return responder(200, {
    token,
    expiresIn: expiraEm,
    cliente: { id: cliente.id, nome: cliente.nome },
  }, correlationId);
}
