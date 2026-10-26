/**
 * Consulta do cliente no OS Service, dono do cadastro de clientes.
 *
 * Na Fase 4 cada serviço tem o próprio banco e nenhum outro componente o lê
 * direto: a Lambda deixa de consultar o PostgreSQL do OS e chama a rota interna
 * `POST /internal/clientes/busca` (docs/contratos.md do OS Service, seção 7).
 * O CPF vai no corpo, não na URL, para não aparecer nos logs. A rota passa pelo
 * mesmo API Gateway e ALB das rotas públicas, então a proteção dela é o token
 * `x-internal-token`, guardado no SSM e lido aqui em runtime.
 */

import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { memoizarSemFalha } from './memoizar.ts';

export interface ClienteDoOs {
  id: string;
  nome: string;
  status: string | null;
}

export interface DependenciasBuscaCliente {
  /** Endereço base da API (o API Gateway), sem barra no fim. */
  urlBase: string;
  obterToken: () => Promise<string>;
  requisitar: typeof fetch;
  /** Limite de cada tentativa. */
  timeoutMs: number;
}

// Uma nova tentativa só para o que pode passar sozinho: timeout, erro de rede
// e 5xx. Um 4xx é configuração (token errado) ou pedido inválido, e repetir não
// muda a resposta.
const TENTATIVAS = 2;

// Duas tentativas de 4 s cabem com folga no timeout de 15 s da função
// (lambda_timeout_seconds), junto com a leitura do token no SSM.
const TIMEOUT_POR_TENTATIVA_MS = 4_000;

class FalhaTransitoria extends Error {}

export function criarBuscaCliente(dependencias: DependenciasBuscaCliente) {
  /** Devolve o cliente, ou `null` se o OS não o conhece. Lança erro nas falhas. */
  return async function buscarCliente(cpf: string, correlationId: string): Promise<ClienteDoOs | null> {
    if (!dependencias.urlBase) throw new Error('OS_API_URL ausente');
    const token = await dependencias.obterToken();

    for (let tentativa = 1; ; tentativa++) {
      try {
        return await tentar(dependencias, token, cpf, correlationId);
      } catch (erro) {
        if (!(erro instanceof FalhaTransitoria) || tentativa === TENTATIVAS) throw erro;
      }
    }
  };
}

async function tentar(
  dependencias: DependenciasBuscaCliente,
  token: string,
  cpf: string,
  correlationId: string,
): Promise<ClienteDoOs | null> {
  let resposta: Response;
  try {
    resposta = await dependencias.requisitar(`${dependencias.urlBase}/internal/clientes/busca`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-token': token,
        // O mesmo id da autenticação nos logs do OS: o login aparece inteiro
        // filtrando pelo correlationId.
        'x-correlation-id': correlationId,
      },
      body: JSON.stringify({ cpf }),
      signal: AbortSignal.timeout(dependencias.timeoutMs),
    });
  } catch (erro) {
    throw new FalhaTransitoria(`OS Service inacessivel: ${erro instanceof Error ? erro.message : String(erro)}`);
  }

  if (resposta.status === 404) return null;
  if (resposta.status >= 500) throw new FalhaTransitoria(`OS Service respondeu ${resposta.status}`);
  if (!resposta.ok) throw new Error(`OS Service respondeu ${resposta.status}`);
  return lerCliente(await resposta.json());
}

function lerCliente(corpo: unknown): ClienteDoOs {
  if (!corpo || typeof corpo !== 'object') throw new Error('Resposta do OS Service fora do contrato');
  const cliente = corpo as Record<string, unknown>;
  if (
    typeof cliente.id !== 'string' ||
    typeof cliente.nome !== 'string' ||
    !(cliente.status === null || typeof cliente.status === 'string')
  ) {
    throw new Error('Resposta do OS Service fora do contrato');
  }
  return { id: cliente.id, nome: cliente.nome, status: cliente.status };
}

const ssm = new SSMClient({});

async function lerTokenDoSsm(): Promise<string> {
  const nome = process.env.INTERNAL_API_TOKEN_SSM_PARAMETER;
  if (!nome) throw new Error('INTERNAL_API_TOKEN_SSM_PARAMETER ausente');
  const resultado = await ssm.send(new GetParameterCommand({ Name: nome, WithDecryption: true }));
  if (!resultado.Parameter?.Value) throw new Error(`Parametro SSM ausente: ${nome}`);
  return resultado.Parameter.Value;
}

export const buscarCliente = criarBuscaCliente({
  urlBase: process.env.OS_API_URL ?? '',
  obterToken: memoizarSemFalha(lerTokenDoSsm),
  requisitar: fetch,
  timeoutMs: TIMEOUT_POR_TENTATIVA_MS,
});
