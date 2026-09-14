/**
 * Observabilidade da Lambda de autenticação: tags padrão, correlação de log
 * com trace e propagação W3C Trace Context.
 *
 * O agente vem da layer do New Relic, não do zip: o esbuild o marca como
 * externo (`--external:newrelic`) e o `require` resolve em runtime a partir de
 * /opt/nodejs/node_modules — o mesmo módulo que o wrapper da layer já carregou.
 * Fora do Lambda (teste local, instrumentação desligada) o `require` falha e
 * tudo aqui vira no-op: o log continua saindo, só sem os campos de correlação.
 */

interface TransacaoNewRelic {
  insertDistributedTraceHeaders?: (cabecalhos: Record<string, string>) => void;
}

interface AgenteNewRelic {
  getLinkingMetadata?: (omitSupportability?: boolean) => Record<string, string>;
  getTransaction?: () => TransacaoNewRelic | undefined;
  addCustomAttributes?: (atributos: Record<string, string | number | boolean>) => void;
}

let agente: AgenteNewRelic | null | undefined;

function carregarAgente(): AgenteNewRelic | null {
  if (agente !== undefined) return agente;

  try {
    agente = require('newrelic') as AgenteNewRelic;
  } catch {
    agente = null;
  }

  return agente;
}

/**
 * Tags padrão do projeto (`environment`, `project`), lidas de NEW_RELIC_LABELS
 * — o mesmo formato e a mesma variável da API no cluster (`chave:valor;...`).
 * Uma consulta com `WHERE environment = ... AND project = ...` atravessa os
 * dois serviços.
 */
export function tagsDeObservabilidade(
  labels: string | undefined = process.env.NEW_RELIC_LABELS,
): Record<string, string> {
  const tags: Record<string, string> = {};

  for (const par of (labels ?? '').split(';')) {
    const separador = par.indexOf(':');
    if (separador <= 0) continue;

    const chave = par.slice(0, separador).trim();
    const valor = par.slice(separador + 1).trim();

    if (chave && valor) tags[chave] = valor;
  }

  return tags;
}

/**
 * `trace.id`, `span.id`, `entity.guid`, `entity.name` — o contrato de "logs in
 * context". Com eles no JSON, cada linha liga ao trace distribuído que a
 * produziu. `true` dispensa a métrica de supportability a cada chamada.
 */
export function metadadosDeTrace(): Record<string, string> {
  try {
    return carregarAgente()?.getLinkingMetadata?.(true) ?? {};
  } catch {
    return {};
  }
}

/**
 * Carimba a invocação (evento `AwsLambdaInvocation`) com as tags do projeto e
 * o correlationId. É o que permite filtrar a Lambda pelas mesmas tags da API e
 * achar a invocação a partir de um log.
 */
export function marcarInvocacao(atributos: Record<string, string>): void {
  try {
    carregarAgente()?.addCustomAttributes?.(atributos);
  } catch {
    // telemetria não interrompe autenticação
  }
}

const TRACEPARENT_VALIDO = /^00-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$/;

/**
 * Valor para o cabeçalho de resposta `traceresponse` (W3C Trace Context
 * Level 2): `00-<trace-id>-<span-id>-<flags>` da invocação atual.
 *
 * Quando o cliente envia `traceparent`, o agente adota o trace-id recebido —
 * e o `traceresponse` devolve esse mesmo trace-id. É a prova, do lado do
 * cliente, de que a Lambda entrou no trace dele; e é o id que ele reenvia à
 * API para as duas pontas ficarem no mesmo trace distribuído.
 *
 * O valor sai do próprio agente (`insertDistributedTraceHeaders`), com flags
 * de amostragem corretas, em vez de ser montado à mão.
 */
export function traceresponseAtual(): string | undefined {
  try {
    const cabecalhos: Record<string, string> = {};
    carregarAgente()?.getTransaction?.()?.insertDistributedTraceHeaders?.(cabecalhos);

    return traceparentValido(cabecalhos.traceparent);
  } catch {
    return undefined;
  }
}

/** Filtra valores fora do formato W3C (versão 00, ids não nulos, hex minúsculo). */
export function traceparentValido(valor: string | undefined): string | undefined {
  return valor && TRACEPARENT_VALIDO.test(valor) ? valor : undefined;
}

/**
 * Cabeçalho HTTP de um evento do API Gateway. No payload 2.0 os nomes chegam
 * em minúsculas; a busca ignora caixa para funcionar também com o 1.0.
 */
export function cabecalho(
  cabecalhos: Record<string, string | undefined> | null | undefined,
  nome: string,
): string | undefined {
  if (!cabecalhos) return undefined;

  const alvo = nome.toLowerCase();
  const chave = Object.keys(cabecalhos).find((k) => k.toLowerCase() === alvo);

  return chave ? cabecalhos[chave] : undefined;
}

const CORRELATION_ID_VALIDO = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * O correlationId vem do cliente e vai parar no log e nos atributos do APM.
 * Aceito só em formato de id (UUID, id do API Gateway, etc.) e com tamanho
 * limitado; qualquer outra coisa é descartada em favor do id da invocação.
 */
export function correlationIdSeguro(valor: string | undefined): string | undefined {
  return valor && CORRELATION_ID_VALIDO.test(valor) ? valor : undefined;
}

/** Usado apenas nos testes. */
export function redefinirAgenteParaTestes(substituto?: AgenteNewRelic | null): void {
  agente = substituto;
}
