import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm';
import nodemailer from 'nodemailer';
import { timingSafeEqual } from 'node:crypto';

interface EventoHttp {
  body?: string | null;
  headers?: Record<string, string | undefined>;
  isBase64Encoded?: boolean;
  requestContext?: { http?: { method?: string } };
}

interface Resposta {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

interface ConfiguracaoMail {
  host: string;
  port: number;
  user: string;
  pass: string;
  apiToken: string;
}

export interface MailTransport {
  sendMail(message: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
}

export interface DependenciasMailHandler {
  obterConfiguracao: () => Promise<ConfiguracaoMail>;
  criarTransport: (configuracao: ConfiguracaoMail) => MailTransport;
}

const ssm = new SSMClient({});
let configuracaoEmCache: Promise<ConfiguracaoMail> | undefined;

function responder(statusCode: number, corpo: unknown, correlationId: string): Resposta {
  return { statusCode, headers: { 'content-type': 'application/json', 'x-correlation-id': correlationId }, body: JSON.stringify(corpo) };
}

function log(nivel: 'info' | 'warn' | 'error', mensagem: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ nivel, mensagem, servico: 'mail-lambda', timestamp: new Date().toISOString(), ...extra }));
}

async function obterConfiguracaoSsm(): Promise<ConfiguracaoMail> {
  const prefixo = process.env.MAIL_SSM_PREFIX;
  if (!prefixo) throw new Error('MAIL_SSM_PREFIX ausente');
  const nomes = ['MAIL_HOST', 'MAIL_PORT', 'MAIL_USER', 'MAIL_PASS', 'MAIL_API_TOKEN'];
  const resultado = await ssm.send(new GetParametersCommand({
    Names: nomes.map((nome) => `${prefixo}/${nome}`), WithDecryption: true,
  }));
  const valores = new Map(resultado.Parameters?.map((p) => [p.Name?.split('/').at(-1), p.Value]) ?? []);
  const ausentes = nomes.filter((nome) => !valores.get(nome));
  if (ausentes.length > 0) throw new Error(`Parametros SSM ausentes: ${ausentes.join(', ')}`);
  const port = Number(valores.get('MAIL_PORT'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MAIL_PORT invalida');
  return { host: valores.get('MAIL_HOST')!, port, user: valores.get('MAIL_USER')!, pass: valores.get('MAIL_PASS')!, apiToken: valores.get('MAIL_API_TOKEN')! };
}

function obterConfiguracao(): Promise<ConfiguracaoMail> {
  configuracaoEmCache ??= obterConfiguracaoSsm();
  return configuracaoEmCache;
}

function criarTransport(configuracao: ConfiguracaoMail): MailTransport {
  return nodemailer.createTransport({
    host: configuracao.host, port: configuracao.port, secure: configuracao.port === 465,
    auth: { user: configuracao.user, pass: configuracao.pass },
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
  });
}

function tokenValido(informado: string | undefined, esperado: string): boolean {
  if (!informado) return false;
  const tokenInformado = Buffer.from(informado);
  const tokenEsperado = Buffer.from(esperado);
  return tokenInformado.length === tokenEsperado.length && timingSafeEqual(tokenInformado, tokenEsperado);
}

function corpoValido(corpo: unknown): corpo is { to: string; subject: string; text: string } {
  if (!corpo || typeof corpo !== 'object') return false;
  const email = corpo as Record<string, unknown>;
  return ['to', 'subject', 'text'].every((campo) => typeof email[campo] === 'string' && email[campo].trim().length > 0);
}

const dependenciasPadrao: DependenciasMailHandler = { obterConfiguracao, criarTransport };

export function criarMailHandler(dependencias = dependenciasPadrao) {
  return async function handler(evento: EventoHttp, contexto: { awsRequestId: string }): Promise<Resposta> {
    const correlationId = contexto?.awsRequestId ?? 'sem-correlacao';
    if (evento.requestContext?.http?.method && evento.requestContext.http.method !== 'POST') {
      return responder(405, { mensagem: 'Metodo nao permitido.' }, correlationId);
    }
    let configuracao: ConfiguracaoMail;
    try {
      configuracao = await dependencias.obterConfiguracao();
    } catch (erro) {
      log('error', 'Falha ao obter configuracao de email', { correlationId, erro: erro instanceof Error ? erro.message : String(erro) });
      return responder(500, { mensagem: 'Erro ao configurar email.' }, correlationId);
    }
    const headerToken = evento.headers?.['x-mail-api-token'] ?? evento.headers?.['X-Mail-Api-Token'];
    if (!tokenValido(headerToken, configuracao.apiToken)) {
      log('warn', 'Token de chamada de email invalido', { correlationId });
      return responder(401, { mensagem: 'Nao autorizado.' }, correlationId);
    }
    let corpo: unknown;
    try {
      const bruto = evento.isBase64Encoded && evento.body ? Buffer.from(evento.body, 'base64').toString('utf8') : evento.body;
      corpo = JSON.parse(bruto ?? '{}');
    } catch {
      return responder(400, { mensagem: 'Corpo da requisicao invalido.' }, correlationId);
    }
    if (!corpoValido(corpo)) return responder(400, { mensagem: 'Campos to, subject e text sao obrigatorios.' }, correlationId);
    try {
      await dependencias.criarTransport(configuracao).sendMail({
        from: process.env.MAIL_FROM ?? '"Oficina SOAT" <noreply@oficina.com>', to: corpo.to, subject: corpo.subject, text: corpo.text,
      });
    } catch (erro) {
      log('error', 'Falha ao enviar email', { correlationId, erro: erro instanceof Error ? erro.message : String(erro) });
      return responder(500, { mensagem: 'Erro ao enviar email.' }, correlationId);
    }
    log('info', 'Email emitido', { correlationId, target: corpo.to });
    return responder(200, { message: 'Email enviado com sucesso.' }, correlationId);
  };
}

export const handler = criarMailHandler();
